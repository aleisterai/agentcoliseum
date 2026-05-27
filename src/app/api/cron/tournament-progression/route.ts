/**
 * GET /api/cron/tournament-progression
 *
 * Every minute (vercel.json), advances tournaments:
 *
 *   1. For each `running` tournament, find tournament_matches whose
 *      underlying match is `completed` but whose tournament_matches
 *      row hasn't been finalized (winner_agent_id NULL). Copy the
 *      winner over.
 *
 *   2. If every match in a given round is finalized:
 *        a. If there's a next round, generate it: create new matches
 *           (mode='free') pairing the round's winners by adjacent
 *           bracket positions, and insert tournament_matches rows
 *           for the next round.
 *        b. If this was the final round, mark the tournament
 *           'completed', set winner_agent_id + completedAt, and pay
 *           out the prize pool to the winner's owner via
 *           operator-wallet USDC.transfer (mirrors settlement-sweep).
 *
 * Idempotent + bounded. Safe to run repeatedly. CRON_SECRET-gated.
 */
import { NextResponse } from "next/server";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  agents,
  matches,
  owners,
  tournaments,
  tournamentEntries,
  tournamentMatches,
} from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { buildEngine } from "@/lib/game/engine";
import { getAdapter } from "@/lib/game/registry";
import { buildNextRound, totalRounds } from "@/lib/tournament";
import { refundStake } from "@/lib/chain/stake";
import { recordCronRun } from "@/lib/cron-audit";
import { authorizedCronRequest } from "@/lib/cron-auth";
import { withCronLock } from "@/lib/cron-lock";
import { broadcastAgent, realtimeEvent } from "@/lib/realtime";
import type {
  TournamentEndedPayload,
  TournamentRoundPayload,
  MatchActivatedPayload,
} from "@/lib/realtime-types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_CLOCK_BUDGET_MS = 5 * 60 * 1000;

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  // Mutex prevents concurrent tournament progressions from racing
  // round-creation + final-payout writes (and contending on operator
  // nonces during the on-chain prize payout step).
  return withCronLock("tournament-progression", () =>
    recordCronRun(
      "tournament-progression",
      async ({ setItems, setMetadata }) => {
        return handleTournamentProgression({ setItems, setMetadata });
      },
    ),
  );
}

async function handleTournamentProgression({
  setItems,
  setMetadata,
}: {
  setItems: (n: number) => void;
  setMetadata: (m: Record<string, unknown>) => void;
}) {
  const running = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.status, "running"))
    .limit(20);

  const summary: Array<{
    tournamentId: string;
    name: string;
    advanced: number;
    roundCreated?: number;
    completed?: boolean;
    payoutTxHash?: string;
    error?: string;
  }> = [];

  for (const t of running) {
    try {
      const result = await advanceOne(t);
      summary.push({ tournamentId: t.id, name: t.name, ...result });
    } catch (err) {
      summary.push({
        tournamentId: t.id,
        name: t.name,
        advanced: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const advanced = summary.reduce((acc, s) => acc + s.advanced, 0);
  const completed = summary.filter((s) => s.completed).length;
  const erroredTournaments = summary.filter((s) => s.error).length;
  setItems(advanced + completed);
  setMetadata({
    runningTournaments: running.length,
    matchesAdvanced: advanced,
    tournamentsCompleted: completed,
    erroredTournaments,
  });
  return NextResponse.json({ ok: true, processed: running.length, summary });
}

async function advanceOne(t: typeof tournaments.$inferSelect): Promise<{
  advanced: number;
  roundCreated?: number;
  completed?: boolean;
  payoutTxHash?: string;
}> {
  // 1. Copy winners from completed matches into tournament_matches rows.
  const allTMatches = await db
    .select()
    .from(tournamentMatches)
    .where(eq(tournamentMatches.tournamentId, t.id))
    .orderBy(
      asc(tournamentMatches.round),
      asc(tournamentMatches.bracketPosition),
    );

  const pendingWinnerCopies = allTMatches.filter(
    (tm) => tm.matchId && tm.winnerAgentId == null,
  );
  let advanced = 0;
  for (const tm of pendingWinnerCopies) {
    const m = await db.query.matches.findFirst({
      where: eq(matches.id, tm.matchId!),
    });
    if (!m || m.status !== "completed") continue;
    // m.winnerAgentId may be null on a draw. Tournaments don't
    // tolerate ties — the better-seeded agent advances. (Simple v1
    // tiebreak; v2 could replay.)
    let winner = m.winnerAgentId;
    if (winner == null) {
      const p1Entry = tm.p1AgentId
        ? await db.query.tournamentEntries.findFirst({
            where: and(
              eq(tournamentEntries.tournamentId, t.id),
              eq(tournamentEntries.agentId, tm.p1AgentId),
            ),
          })
        : null;
      const p2Entry = tm.p2AgentId
        ? await db.query.tournamentEntries.findFirst({
            where: and(
              eq(tournamentEntries.tournamentId, t.id),
              eq(tournamentEntries.agentId, tm.p2AgentId),
            ),
          })
        : null;
      // Lower seed wins on tiebreak (seed 1 > seed 16).
      if (p1Entry?.seed && p2Entry?.seed) {
        winner = p1Entry.seed < p2Entry.seed ? tm.p1AgentId : tm.p2AgentId;
      } else {
        winner = tm.p1AgentId ?? tm.p2AgentId;
      }
    }
    await db
      .update(tournamentMatches)
      .set({ winnerAgentId: winner })
      .where(eq(tournamentMatches.id, tm.id));
    // Stamp the loser's eliminatedRound in tournament_entries.
    const loserId =
      winner === tm.p1AgentId
        ? tm.p2AgentId
        : winner === tm.p2AgentId
          ? tm.p1AgentId
          : null;
    if (loserId) {
      await db
        .update(tournamentEntries)
        .set({ eliminatedRound: tm.round })
        .where(
          and(
            eq(tournamentEntries.tournamentId, t.id),
            eq(tournamentEntries.agentId, loserId),
          ),
        );
      // Wake any tournament_status(wait:true) the loser has open —
      // AGE-55 contract: must await on Vercel or the broadcast gets
      // dropped when the cron handler returns.
      await broadcastAgent(loserId, realtimeEvent.TournamentEnded, {
        tournamentId: t.id,
        eliminatedRound: tm.round,
        isWinner: false,
      } satisfies TournamentEndedPayload);
    }
    advanced++;
  }

  // 2. Check if a round is fully decided + needs a next round (or final completion).
  const fresh = await db
    .select()
    .from(tournamentMatches)
    .where(eq(tournamentMatches.tournamentId, t.id))
    .orderBy(
      asc(tournamentMatches.round),
      asc(tournamentMatches.bracketPosition),
    );

  const byRound = new Map<number, typeof fresh>();
  for (const tm of fresh) {
    const r = byRound.get(tm.round) ?? [];
    r.push(tm);
    byRound.set(tm.round, r);
  }
  const lastRound = Math.max(...byRound.keys());
  const lastRoundMatches = byRound.get(lastRound)!;
  const allLastDecided = lastRoundMatches.every(
    (tm) => tm.winnerAgentId != null,
  );

  if (!allLastDecided) {
    return { advanced };
  }

  const rounds = totalRounds(t.size);
  if (lastRound < rounds) {
    // Create the next round.
    const adapter = getAdapter(t.gameType);
    if (!adapter) throw new Error(`Missing adapter for ${t.gameType}`);
    const engine = buildEngine(adapter.game);
    const nextPairings = buildNextRound(
      lastRoundMatches.map((tm) => ({
        bracketPosition: tm.bracketPosition,
        winnerAgentId: tm.winnerAgentId,
      })),
    );
    // Collect the new (p1, p2, matchId) tuples so we can broadcast
    // TournamentRound + MatchActivated AFTER the tx commits. Doing
    // it inside the tx would broadcast even on a rollback.
    const createdRoundMatches: Array<{
      matchId: string;
      p1AgentId: string;
      p2AgentId: string;
    }> = [];
    await db.transaction(async (tx) => {
      for (const pair of nextPairings) {
        if (!pair.p1AgentId || !pair.p2AgentId) continue;
        const initialState = engine.initialState();
        const [matchRow] = await tx
          .insert(matches)
          .values({
            gameType: t.gameType,
            mode: "free",
            p1AgentId: pair.p1AgentId,
            p2AgentId: pair.p2AgentId,
            state: initialState,
            status: "active",
            currentTurnPlayerId: "0",
            currentTurnAgentId: pair.p1AgentId,
            p1MsLeft: DEFAULT_CLOCK_BUDGET_MS,
            p2MsLeft: DEFAULT_CLOCK_BUDGET_MS,
            clockBudgetMs: DEFAULT_CLOCK_BUDGET_MS,
          })
          .returning({ id: matches.id });
        await tx.insert(tournamentMatches).values({
          tournamentId: t.id,
          matchId: matchRow.id,
          round: lastRound + 1,
          bracketPosition: pair.bracketPosition,
          p1AgentId: pair.p1AgentId,
          p2AgentId: pair.p2AgentId,
        });
        createdRoundMatches.push({
          matchId: matchRow.id,
          p1AgentId: pair.p1AgentId,
          p2AgentId: pair.p2AgentId,
        });
      }
    });
    // Wake both sides of every new bracket match. Awaited per AGE-55
    // so Vercel doesn't drop the broadcast on cron-handler return.
    // We send BOTH TournamentRound (for tournament_status long-polls)
    // and MatchActivated (for match_list long-polls) so whichever
    // surface the agent is sitting on wakes immediately.
    const roundPayload = (matchId: string): TournamentRoundPayload => ({
      tournamentId: t.id,
      matchId,
      round: lastRound + 1,
      gameType: t.gameType,
    });
    const activatedPayload = (matchId: string): MatchActivatedPayload => ({
      matchId,
      gameType: t.gameType,
      mode: "free",
    });
    await Promise.all(
      createdRoundMatches.flatMap((m) => [
        broadcastAgent(
          m.p1AgentId,
          realtimeEvent.TournamentRound,
          roundPayload(m.matchId),
        ),
        broadcastAgent(
          m.p2AgentId,
          realtimeEvent.TournamentRound,
          roundPayload(m.matchId),
        ),
        broadcastAgent(
          m.p1AgentId,
          realtimeEvent.MatchActivated,
          activatedPayload(m.matchId),
        ),
        broadcastAgent(
          m.p2AgentId,
          realtimeEvent.MatchActivated,
          activatedPayload(m.matchId),
        ),
      ]),
    );
    return { advanced, roundCreated: lastRound + 1 };
  }

  // Final completed — pay out + flip status.
  const finalMatch = lastRoundMatches[0];
  if (!finalMatch?.winnerAgentId) return { advanced };
  const winnerAgent = await db.query.agents.findFirst({
    where: eq(agents.id, finalMatch.winnerAgentId),
  });
  if (!winnerAgent) return { advanced };
  // Tournament winners must have an owner row to receive the prize.
  // Free-tier agents can register for free tournaments only — and a
  // paid tournament's registration step would have already required
  // a linked wallet. So this is defence-in-depth.
  if (!winnerAgent.ownerId) return { advanced };
  const winnerOwner = await db.query.owners.findFirst({
    where: eq(owners.id, winnerAgent.ownerId),
  });
  if (!winnerOwner) return { advanced };

  let payoutTxHash: string | undefined;
  if (t.prizePoolUsdc > 0 && process.env.PLATFORM_OPERATOR_PRIVATE_KEY) {
    // We re-use refundStake (operator → owner USDC.transfer) since
    // mechanically it's the same op as a refund: move USDC from
    // operator → recipient.
    try {
      payoutTxHash = await refundStake(
        winnerOwner.walletAddress as `0x${string}`,
        t.prizePoolUsdc,
      );
    } catch (err) {
      console.error("[cron/tournament-progression] payout failed", {
        tournamentId: t.id,
        err,
      });
      // Don't flip to completed if payout failed — leave 'running'
      // so the next tick retries. Operator can also force-pay from
      // /admin/treasury if it stays stuck.
      return { advanced };
    }
  }

  await db
    .update(tournaments)
    .set({
      status: "completed",
      winnerAgentId: winnerAgent.id,
      completedAt: new Date(),
    })
    .where(eq(tournaments.id, t.id));
  await db
    .update(tournamentEntries)
    .set({ eliminatedRound: 0 }) // winner sentinel
    .where(
      and(
        eq(tournamentEntries.tournamentId, t.id),
        eq(tournamentEntries.agentId, winnerAgent.id),
      ),
    );
  // Wake the winner's tournament_status(wait:true). Awaited per
  // AGE-55 so the broadcast survives the cron handler's return.
  await broadcastAgent(winnerAgent.id, realtimeEvent.TournamentEnded, {
    tournamentId: t.id,
    eliminatedRound: 0,
    isWinner: true,
  } satisfies TournamentEndedPayload);

  return { advanced, completed: true, payoutTxHash };
}
