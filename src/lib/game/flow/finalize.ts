/**
 * Terminal flow: turn an active match into a completed one.
 *
 * Responsibilities (all in a single transaction):
 *   1. Look up the match FOR UPDATE; bail idempotently if already terminal.
 *   2. Compute ELO updates for both agents (skipped for system-mode).
 *   3. Update agent win/loss/draw counters + ratings.
 *   4. Upsert the head_to_head aggregate row (canonical agentA < agentB ordering).
 *   5. Mark the match completed, write final state + clock + ELO delta.
 *   6. Insert a treasury_flow row for paid matches with a non-zero fee.
 *      Draws (Option A: full refund) skip this insert.
 *   7. Build + upsert the immutable match transcript for the agent profile.
 *   8. Resolve the side-pool row (resolvedAt = now).
 *
 * After commit (NOT inside the transaction — see broadcast-out-of-tx
 * comment): fire GameEnded broadcasts on both the match channel and
 * the lobby channel. Done in `.then()` so a slow Realtime REST round-
 * trip can't hold a Postgres connection.
 *
 * `finalizeMatch` is called from:
 *   - match-flow.applyMove (move ended the game OR forfeit fired)
 *   - match-flow.driveSystemBot (same paths for system-bot opponent)
 *   - clock-flow.enforceClockExpiry (cron-triggered timeout)
 * Each call site provides a winnerAgentId (null only on draws + edge
 * abandons) and a `resultReason` enum value.
 */
import "server-only";
import { eq, sql as dsql } from "drizzle-orm";
import type { State } from "boardgame.io";
import { db } from "@/lib/db/client";
import {
  agents,
  headToHead,
  matches,
  matchMoves,
  matchTranscripts,
  sidePools,
  treasuryFlows,
  type Match,
} from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { buildTranscript } from "@/lib/game/snapshot";
import { eloUpdate, payoutSplit, type ResultReason } from "@/lib/game/lifecycle";
import { broadcastGame, broadcastLobby, realtimeEvent } from "@/lib/realtime";
import type { GameEndedPayload, LobbyGameEndedPayload } from "@/lib/realtime-types";
import { MatchNotFoundError } from "./errors";

export interface FinalizeArgs {
  matchId: string;
  winnerAgentId: string | null;
  resultReason: ResultReason;
  finalP1Ms: number;
  finalP2Ms: number;
  /** Optional latest state — used if we already have it (avoid extra DB roundtrip). */
  finalState?: State<unknown>;
}

export async function finalizeMatch(args: FinalizeArgs): Promise<Match> {
  return db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(matches)
      .where(eq(matches.id, args.matchId))
      .for("update")
      .limit(1);
    if (!match) throw new MatchNotFoundError();
    if (match.status === "completed" || match.status === "abandoned") {
      // Idempotent: another path already finalized this match. Skip the
      // re-broadcast — listeners already got the original GameEnded.
      return { updated: match, broadcastPayload: null };
    }

    const adapter = getAdapter(match.gameType);

    // Compute Elo if both sides are real agents and the match wasn't system mode.
    let p1Delta = 0;
    let p2Delta = 0;
    if (match.mode !== "system" && match.p1AgentId && match.p2AgentId) {
      const [p1Agent, p2Agent] = await Promise.all([
        tx.select().from(agents).where(eq(agents.id, match.p1AgentId)).limit(1),
        tx.select().from(agents).where(eq(agents.id, match.p2AgentId)).limit(1),
      ]);
      const p1 = p1Agent[0];
      const p2 = p2Agent[0];
      if (p1 && p2) {
        const outcome =
          args.resultReason === "draw" || args.winnerAgentId === null
            ? "draw"
            : args.winnerAgentId === p1.id
              ? "p1_win"
              : "p2_win";
        const updated = eloUpdate({ p1Elo: p1.elo, p2Elo: p2.elo, outcome });
        p1Delta = updated.p1Delta;
        p2Delta = updated.p2Delta;
        await tx
          .update(agents)
          .set({
            elo: updated.p1Elo,
            ...(outcome === "p1_win"
              ? { wins: dsql`${agents.wins} + 1` }
              : outcome === "p2_win"
                ? { losses: dsql`${agents.losses} + 1` }
                : { draws: dsql`${agents.draws} + 1` }),
          })
          .where(eq(agents.id, p1.id));
        await tx
          .update(agents)
          .set({
            elo: updated.p2Elo,
            ...(outcome === "p2_win"
              ? { wins: dsql`${agents.wins} + 1` }
              : outcome === "p1_win"
                ? { losses: dsql`${agents.losses} + 1` }
                : { draws: dsql`${agents.draws} + 1` }),
          })
          .where(eq(agents.id, p2.id));
      }
      // Head-to-head aggregate (canonical order: smaller uuid string first).
      const [aId, bId] = p1.id < p2.id ? [p1.id, p2.id] : [p2.id, p1.id];
      const aWins = args.winnerAgentId === aId ? 1 : 0;
      const bWins = args.winnerAgentId === bId ? 1 : 0;
      const draws =
        args.winnerAgentId === null && args.resultReason !== "abandoned" ? 1 : 0;
      await tx
        .insert(headToHead)
        .values({
          agentAId: aId,
          agentBId: bId,
          gameType: match.gameType,
          aWins,
          bWins,
          draws,
          lastPlayedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [headToHead.agentAId, headToHead.agentBId, headToHead.gameType],
          set: {
            aWins: dsql`${headToHead.aWins} + ${aWins}`,
            bWins: dsql`${headToHead.bWins} + ${bWins}`,
            draws: dsql`${headToHead.draws} + ${draws}`,
            lastPlayedAt: new Date(),
          },
        });
    }

    // Mark match completed.
    const now = new Date();
    const [updated] = await tx
      .update(matches)
      .set({
        status: "completed",
        winnerAgentId: args.winnerAgentId,
        resultReason: args.resultReason,
        currentTurnAgentId: null,
        p1MsLeft: args.finalP1Ms,
        p2MsLeft: args.finalP2Ms,
        p1EloDelta: p1Delta,
        p2EloDelta: p2Delta,
        completedAt: now,
        ...(args.finalState ? { state: args.finalState as unknown as object } : {}),
      })
      .where(eq(matches.id, match.id))
      .returning();

    // Treasury flow for paid matches. Draws pay zero treasury fee
    // (Option A — full refund), so we skip the insert entirely on a
    // 0-value flow to avoid littering the treasury_flows table with
    // no-op rows that the swap cron would only filter out anyway.
    if (match.mode === "paid" && match.potUsdc) {
      const split = payoutSplit({
        potUsdc: match.potUsdc,
        isDraw: args.resultReason === "draw" || args.winnerAgentId === null,
        stakeUsdc: match.stakeUsdc ?? 0,
      });
      if (split.treasury > 0) {
        await tx.insert(treasuryFlows).values({
          matchId: match.id,
          feeUsdc: split.treasury,
          status: "pending",
        });
      }
    }

    // Build and write the transcript.
    if (adapter) {
      const movesForMatch = await tx
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, match.id))
        .orderBy(matchMoves.moveNumber);
      const initial = buildEngine(adapter.game).initialState();
      const finalState =
        (args.finalState ?? (updated.state as State<unknown>)) as State<unknown>;
      const transcript = buildTranscript({
        matchId: match.id,
        adapter,
        initialState: initial,
        moves: movesForMatch.map((m) => ({
          moveNumber: m.moveNumber,
          agentId: m.agentId,
          playerId: m.playerId,
          payload: m.payload,
          reasoning: m.reasoning,
          evScore: m.evScore,
          thinkingMs: m.thinkingMs,
          x402PaymentId: m.x402PaymentId,
          stateAfter: m.stateAfter as State<unknown>,
          createdAt: m.createdAt,
        })),
        finalState,
        resultReason: args.resultReason,
        winnerAgentId: args.winnerAgentId,
        startedAt: match.startedAt,
        completedAt: now,
      });
      await tx
        .insert(matchTranscripts)
        .values({ matchId: match.id, payload: transcript as object })
        .onConflictDoUpdate({
          target: matchTranscripts.matchId,
          set: { payload: transcript as object, createdAt: new Date() },
        });
    }

    // Side pool resolution.
    await tx
      .update(sidePools)
      .set({ resolvedAt: now })
      .where(eq(sidePools.matchId, match.id));

    // Stash the broadcast payload for fire-and-forget AFTER commit.
    // Doing the Realtime RPC inside the transaction holds a Postgres
    // connection through the round-trip; under load (6+ concurrent
    // finalizers on the same tick) that exhausts the pool.
    return {
      updated,
      broadcastPayload: {
        matchId: match.id,
        winnerAgentId: args.winnerAgentId,
        resultReason: args.resultReason,
        p1EloDelta: p1Delta,
        p2EloDelta: p2Delta,
      } satisfies GameEndedPayload,
    };
  }).then(async ({ updated, broadcastPayload }) => {
    // After commit: fire GameEnded broadcasts. broadcastPayload is null
    // on the idempotent re-finalize path — skip the duplicate.
    if (broadcastPayload) {
      await broadcastGame(updated.id, realtimeEvent.GameEnded, broadcastPayload);
      const lobbyPayload: LobbyGameEndedPayload = { id: updated.id };
      await broadcastLobby(realtimeEvent.GameEnded, lobbyPayload);
    }
    return updated;
  });
}
