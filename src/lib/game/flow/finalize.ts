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
 *
 * **Two entry points:**
 *   - `finalizeMatch(args)` — opens its own transaction, fires
 *     broadcasts after commit. Used by paths that aren't already
 *     inside a tx (clock cron, top-level driveSystemBot).
 *   - `finalizeMatchTx(tx, args)` — runs the body inside an existing
 *     tx, returns the broadcast payload for the caller to fire after
 *     IT commits. Used by `applyMove`, which now wraps its full
 *     read-modify-write cycle in a single transaction with
 *     `SELECT ... FOR UPDATE` on the match row (anti-double-move).
 *     Nested `db.transaction(...)` calls would deadlock the pool
 *     since each opens a fresh connection.
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
  matchPayouts,
  matchTranscripts,
  owners,
  sidePools,
  treasuryFlows,
  type Match,
} from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { buildTranscript } from "@/lib/game/snapshot";
import {
  eloUpdate,
  payoutSplit,
  type ResultReason,
} from "@/lib/game/lifecycle";
import { broadcastGame, broadcastLobby, realtimeEvent } from "@/lib/realtime";
import type {
  GameEndedPayload,
  LobbyGameEndedPayload,
} from "@/lib/realtime-types";
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

/**
 * Drizzle's transaction type, inferred from `db.transaction`. We keep
 * this loose (parameter of the inner callback) instead of trying to
 * spell out `PgTransaction<PostgresJsQueryResultHKT, ...>` by hand —
 * the surface tx uses (select/insert/update with .for("update")) is
 * identical to `db` for our purposes.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run the finalize body inside `tx`. Returns the updated match row +
 * the GameEnded broadcast payload (null if the match was already
 * terminal — caller skips re-broadcasting in that case).
 *
 * **The caller is responsible for firing broadcasts AFTER their own
 * `tx` commits.** See `finalizeMatch` below for the canonical pattern.
 */
export async function finalizeMatchTx(
  tx: Tx,
  args: FinalizeArgs,
): Promise<{
  updated: Match;
  broadcastPayload: GameEndedPayload | null;
}> {
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
  // ABANDONED matches (no game actually played — both sides got refunded;
  // see flow/clock.ts:enforceClockExpiry moveCount=0 gate) skip ELO + W/L/D
  // entirely. Treating them like draws would have given a "draw" ELO Δ
  // and incremented agent.draws on a match where neither side played a
  // single move — punishing one player for the other's offline state.
  const isAbandoned = args.resultReason === "abandoned";
  let p1Delta = 0;
  let p2Delta = 0;
  if (
    !isAbandoned &&
    match.mode !== "system" &&
    match.p1AgentId &&
    match.p2AgentId
  ) {
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
      ...(args.finalState
        ? { state: args.finalState as unknown as object }
        : {}),
    })
    .where(eq(matches.id, match.id))
    .returning();

  // Two-tier onboarding counter (2026-05). Every completed PAID
  // match increments `agents.paid_games_played` on both sides — the
  // gate that flips Play-tier agents into needing Initiator after
  // their 5th paid game. Sticky counter; never resets on wallet
  // disconnect / reconnect / owner change. Counts ALL paid endings:
  // natural, time_forfeit, invalid_move_forfeit, draw, abandoned —
  // because each one represents a game that consumed a slot.
  if (match.mode === "paid") {
    if (match.p1AgentId) {
      await tx
        .update(agents)
        .set({ paidGamesPlayed: dsql`${agents.paidGamesPlayed} + 1` })
        .where(eq(agents.id, match.p1AgentId));
    }
    if (match.p2AgentId) {
      await tx
        .update(agents)
        .set({ paidGamesPlayed: dsql`${agents.paidGamesPlayed} + 1` })
        .where(eq(agents.id, match.p2AgentId));
    }
  }

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

    // ── match_payouts rows (idempotent per-recipient) ─────────────
    //
    // The settlement-sweep cron reads `match_payouts WHERE status='pending'`
    // and sends ONE on-chain transfer per row. Inserting payout rows here
    // (inside the same tx that marks the match completed) means the cron
    // can never observe "match completed but no payout row" — they
    // arrive together. The UNIQUE (matchId, recipientAddress, reason)
    // constraint + onConflictDoNothing makes this safe to re-run (e.g.
    // idempotent re-finalize during a clock-cron retry).
    //
    // Reasons:
    //   abandoned   → refund both sides at stakeUsdc; no treasury fee
    //   draw        → refund both sides at refundEach; no treasury fee
    //   winner      → pay winner split.winnerCut; treasury_fee at split.treasury
    const stakeUsdc = match.stakeUsdc ?? 0;
    if (isAbandoned) {
      // Both sides refunded. No ELO Δ, no treasury fee — the game
      // never actually played out.
      if (stakeUsdc > 0) {
        await enqueueRefund(
          tx,
          match.id,
          match.p1AgentId,
          stakeUsdc,
          "abandon_refund",
        );
        await enqueueRefund(
          tx,
          match.id,
          match.p2AgentId,
          stakeUsdc,
          "abandon_refund",
        );
      }
    } else if (split.refundEach && split.refundEach > 0) {
      // Draw: each side gets refundEach back. No treasury fee insert
      // (above) on draws by Option A policy.
      await enqueueRefund(
        tx,
        match.id,
        match.p1AgentId,
        split.refundEach,
        "draw_refund",
      );
      await enqueueRefund(
        tx,
        match.id,
        match.p2AgentId,
        split.refundEach,
        "draw_refund",
      );
    } else if (args.winnerAgentId && split.winnerCut > 0) {
      // Natural / forfeit win: winner gets winnerCut; treasury_flows
      // row above already captured the 5% fee.
      await enqueueWinnerPayout(
        tx,
        match.id,
        args.winnerAgentId,
        split.winnerCut,
      );
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
    const finalState = (args.finalState ??
      (updated.state as State<unknown>)) as State<unknown>;
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
}

/**
 * Public entry: open a transaction, run the finalize body, fire
 * broadcasts after commit. Existing call sites (clock cron,
 * driveSystemBot) target this — no signature change.
 *
 * For callers ALREADY inside a transaction (`applyMove`), use
 * `finalizeMatchTx(tx, args)` directly and fire the returned
 * broadcast payload after YOUR commit. Nested `db.transaction(...)`
 * acquires a fresh connection from the pool and would block forever
 * waiting on the outer tx's FOR UPDATE lock.
 */
export async function finalizeMatch(args: FinalizeArgs): Promise<Match> {
  const { updated, broadcastPayload } = await db.transaction(async (tx) =>
    finalizeMatchTx(tx, args),
  );
  if (broadcastPayload) {
    await fireFinalizeBroadcasts(updated.id, broadcastPayload);
  }
  return updated;
}

/**
 * Fire the post-commit GameEnded broadcasts. Exported so `applyMove`
 * (which calls `finalizeMatchTx` directly) can reuse the same logic
 * after its outer tx commits.
 */
export async function fireFinalizeBroadcasts(
  matchId: string,
  payload: GameEndedPayload,
): Promise<void> {
  await broadcastGame(matchId, realtimeEvent.GameEnded, payload);
  const lobbyPayload: LobbyGameEndedPayload = { id: matchId };
  await broadcastLobby(realtimeEvent.GameEnded, lobbyPayload);

  // Per-agent broadcasts (added 2026-05 for autonomous-play
  // wake-ups). Each player's per-agent channel receives a MatchEnded
  // so a long-polling `coliseum_match_list({wait:true})` returns
  // immediately. Lazy-imported to keep this leaf file decoupled from
  // the broadcastAgent helper (and to avoid pulling supabase admin
  // client into modules that don't need it).
  try {
    const [{ broadcastAgent }, { realtimeEvent: ev }, { db }, { matches: matchesT }] =
      await Promise.all([
        import("@/lib/realtime"),
        import("@/lib/supabase"),
        import("@/lib/db/client"),
        import("@/lib/db/schema"),
      ]);
    const m = await db.query.matches.findFirst({
      where: (rows, { eq }) => eq(rows.id, matchId),
      columns: { p1AgentId: true, p2AgentId: true },
    });
    void matchesT; // type-only reference to keep tree-shaker happy
    // GameEndedPayload already carries `matchId` — the per-agent
    // listeners want the same shape the match-channel listener sees.
    if (m?.p1AgentId)
      await broadcastAgent(m.p1AgentId, ev.MatchEnded, payload);
    if (m?.p2AgentId)
      await broadcastAgent(m.p2AgentId, ev.MatchEnded, payload);
  } catch (err) {
    // Fire-and-forget — don't fail finalize if per-agent broadcast
    // hits an issue.
    console.warn("[finalize] per-agent broadcast failed", err);
  }
}

/**
 * Enqueue a refund payout row for one side of a match. Looks up the
 * agent's owner wallet inside the tx (so the recipient is captured at
 * finalize time — if the owner rotates wallets later, the committed
 * payout still goes where the agreement was struck). Idempotent via
 * the (matchId, recipientAddress, payoutReason) unique constraint.
 *
 * Returns silently if the agent has no wallet (already-recalled
 * agents, system-mode opponents). The cron has nothing to do in those
 * cases; better to no-op at finalize than to insert a row the cron
 * can never resolve.
 */
async function enqueueRefund(
  tx: Tx,
  matchId: string,
  agentId: string | null,
  amountUsdc: number,
  reason: "draw_refund" | "abandon_refund",
): Promise<void> {
  if (!agentId || amountUsdc <= 0) return;
  const wallet = await loadAgentWallet(tx, agentId);
  if (!wallet) return;
  await tx
    .insert(matchPayouts)
    .values({
      matchId,
      recipientAddress: wallet,
      recipientAgentId: agentId,
      payoutReason: reason,
      amountUsdc,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [
        matchPayouts.matchId,
        matchPayouts.recipientAddress,
        matchPayouts.payoutReason,
      ],
    });
}

/**
 * Enqueue the winner's 95%-of-pot payout row. Same idempotency
 * contract as `enqueueRefund` — re-finalize is a no-op.
 */
async function enqueueWinnerPayout(
  tx: Tx,
  matchId: string,
  winnerAgentId: string,
  amountUsdc: number,
): Promise<void> {
  if (amountUsdc <= 0) return;
  const wallet = await loadAgentWallet(tx, winnerAgentId);
  if (!wallet) return;
  await tx
    .insert(matchPayouts)
    .values({
      matchId,
      recipientAddress: wallet,
      recipientAgentId: winnerAgentId,
      payoutReason: "winner",
      amountUsdc,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [
        matchPayouts.matchId,
        matchPayouts.recipientAddress,
        matchPayouts.payoutReason,
      ],
    });
}

/** Read an agent's owner wallet inside the active tx. Returns null
 *  for orphan agents (owner row gone) — caller skips the insert. */
async function loadAgentWallet(
  tx: Tx,
  agentId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ wallet: owners.walletAddress })
    .from(agents)
    .innerJoin(owners, eq(agents.ownerId, owners.id))
    .where(eq(agents.id, agentId))
    .limit(1);
  return rows[0]?.wallet ?? null;
}
