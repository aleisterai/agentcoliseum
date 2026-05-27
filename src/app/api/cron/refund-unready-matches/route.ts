/**
 * GET /api/cron/refund-unready-matches
 *
 * Sweeps **ghost matches** — match rows created at challenge-accept
 * or system-mode propose where the on-turn agent never called
 * coliseum_match_state (so agentReadyAt stayed null). Without this
 * reaper the match sits frozen indefinitely: the per-move clock is
 * deliberately paused via the agentReadyAt gate (see lifecycle.ts:
 * clockExpired), so timeout-games never fires. Real-world cause: the
 * LLM hit a Claude.ai web permission prompt the user never approved.
 *
 * Runs every minute (vercel.json). Bounded batch, idempotent.
 *
 * Selection:
 *   status='active'
 *   AND move_count = 0
 *   AND agent_ready_at IS NULL
 *   AND started_at < now() - 30 minutes
 *
 * Per match: call `finalizeMatch(resultReason='abandoned')`. As of
 * the match_payouts refactor, finalize enqueues `abandon_refund`
 * payout rows for both sides — settlement-sweep drains them on its
 * next tick, idempotently per recipient. We no longer call
 * `refundStake` directly from here, so the cron can't double-send if
 * it crashes between p1 and p2 (each recipient is its own row with
 * its own UNIQUE constraint).
 *
 * NOT a time-forfeit — the game never started, neither player did
 * anything wrong. `abandoned` is the correct resultReason and ELO
 * stays untouched (matches.test.ts already covers this branch for
 * the existing abandoned-challenge path).
 */
import { NextResponse } from "next/server";
import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matches } from "@/lib/db/schema";
import { finalizeMatch } from "@/lib/game/flow/finalize";
import { jsonError } from "@/lib/http";
import { recordCronRun } from "@/lib/cron-audit";
import { authorizedCronRequest } from "@/lib/cron-auth";
import { withCronLock } from "@/lib/cron-lock";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 10;
const UNREADY_MAX_MS = 30 * 60 * 1000; // 30 minutes

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  // Mutex serializes operator-wallet refunds for unready matches.
  return withCronLock("refund-unready-matches", () =>
    recordCronRun(
      "refund-unready-matches",
      async ({ setItems, setMetadata }) => {
        return handle({ setItems, setMetadata });
      },
    ),
  );
}

interface PerMatchOutcome {
  matchId: string;
  outcome: "abandoned" | "error";
  detail?: string;
}

async function handle({
  setItems,
  setMetadata,
}: {
  setItems: (n: number) => void;
  setMetadata: (m: Record<string, unknown>) => void;
}) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - UNREADY_MAX_MS);

  // Selection: matches still 'active', no first move played, no
  // readiness signal received, created more than 30 min ago.
  const stuck = await db
    .select({
      id: matches.id,
      mode: matches.mode,
      stakeUsdc: matches.stakeUsdc,
      p1AgentId: matches.p1AgentId,
      p2AgentId: matches.p2AgentId,
      startedAt: matches.startedAt,
    })
    .from(matches)
    .where(
      and(
        eq(matches.status, "active"),
        eq(matches.moveCount, 0),
        isNull(matches.agentReadyAt),
        lt(matches.startedAt, cutoff),
      ),
    )
    .limit(BATCH_LIMIT);

  if (stuck.length === 0) {
    setItems(0);
    setMetadata({ abandoned: 0, errored: 0 });
    return NextResponse.json({
      ok: true,
      abandoned: 0,
      message: "no stuck matches",
    });
  }

  const results: PerMatchOutcome[] = [];

  for (const m of stuck) {
    try {
      // Close via finalizeMatch — NOT a raw UPDATE. finalizeMatch is
      // the single source of truth for match completion: it transacts
      // the row update, enqueues `abandon_refund` payout rows for
      // paid matches (settlement-sweep drains them), and fires the
      // GameEnded Supabase Realtime broadcast so any spectator on the
      // match page sees the end state without having to refresh.
      // Doing a raw UPDATE here would have skipped the broadcast AND
      // the per-recipient idempotency. resultReason='abandoned'
      // signals to finalize to skip ELO Δ + W/L/D counter changes
      // (the policy from the moveCount=0 fairness gate).
      await finalizeMatch({
        matchId: m.id,
        winnerAgentId: null,
        resultReason: "abandoned",
        finalP1Ms: 0,
        finalP2Ms: 0,
      });
      results.push({ matchId: m.id, outcome: "abandoned" });
    } catch (err) {
      console.error(`[cron/refund-unready-matches] ${m.id} failed`, err);
      results.push({
        matchId: m.id,
        outcome: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const abandoned = results.filter((r) => r.outcome === "abandoned").length;
  const errored = results.filter((r) => r.outcome === "error").length;
  setItems(abandoned);
  setMetadata({ abandoned, errored, batchSize: results.length });
  return NextResponse.json({
    ok: true,
    abandoned,
    errored,
    results,
  });
}
