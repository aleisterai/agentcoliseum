/**
 * GET /api/cron/pause-cleanup
 *
 * Long-tail backstop for the pause/resume primitive (2026-05-28).
 *
 * Normal recovery: when an agent's owner reconnects any MCP client,
 * the dispatcher auto-resumes their paused matches on the next tool
 * call. No cron involvement needed.
 *
 * BUT: if the owner never reconnects, the match would sit `paused`
 * forever — locking stakes, blocking ELO updates, cluttering the
 * lobby's spectator surface. This cron sweeps two cases:
 *
 *   1. Paused for longer than PAUSED_MAX_DURATION_MS (7 days)
 *      → finalize as `abandoned`. Both sides refunded. No ELO change.
 *      The owner just never came back.
 *
 *   2. (handled inline in enforceClockExpiry, not here) pause_count
 *      has hit PAUSE_COUNT_MAX before this cron sees the row —
 *      finalize as `time_forfeit` with the OPPONENT winning. The
 *      anti-grief floor.
 *
 * Runs every 5 minutes (vercel.json). Bounded batch + idempotent.
 *
 * The cron is wrapped in withCronLock + recordCronRun for parity with
 * the rest of the cron fleet.
 */
import { NextResponse } from "next/server";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matches } from "@/lib/db/schema";
import { finalizeMatch } from "@/lib/game/flow/finalize";
import { PAUSED_MAX_DURATION_MS } from "@/lib/game/lifecycle";
import { jsonError } from "@/lib/http";
import { recordCronRun } from "@/lib/cron-audit";
import { authorizedCronRequest } from "@/lib/cron-auth";
import { withCronLock } from "@/lib/cron-lock";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 20;

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  return withCronLock("pause-cleanup", () =>
    recordCronRun("pause-cleanup", async ({ setItems, setMetadata }) => {
      return handle({ setItems, setMetadata });
    }),
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
  const cutoff = new Date(now.getTime() - PAUSED_MAX_DURATION_MS);

  // Selection: matches still 'paused' AND paused_at < (now - 7 days).
  // The partial index `matches_paused_idx` makes this O(matched-rows).
  const stale = await db
    .select({
      id: matches.id,
      mode: matches.mode,
      stakeUsdc: matches.stakeUsdc,
      p1AgentId: matches.p1AgentId,
      p2AgentId: matches.p2AgentId,
      pausedAt: matches.pausedAt,
    })
    .from(matches)
    .where(
      and(
        eq(matches.status, "paused"),
        lt(matches.pausedAt, cutoff),
      ),
    )
    .limit(BATCH_LIMIT);

  if (stale.length === 0) {
    setItems(0);
    setMetadata({ abandoned: 0, errored: 0 });
    return NextResponse.json({
      ok: true,
      abandoned: 0,
      message: "no stale paused matches",
    });
  }

  const results: PerMatchOutcome[] = [];

  for (const m of stale) {
    try {
      // Same finalize path as the unready-matches cron — finalizeMatch
      // is the single source of truth. resultReason='abandoned' marks
      // it as "no one wins; refund both sides" so:
      //   - ELO Δ stays 0 on both sides
      //   - W/L/D counters don't move
      //   - settlement-sweep enqueues abandon_refund payout rows
      //     scoped to each side (idempotent per-recipient).
      await finalizeMatch({
        matchId: m.id,
        winnerAgentId: null,
        resultReason: "abandoned",
        finalP1Ms: 0,
        finalP2Ms: 0,
      });
      results.push({ matchId: m.id, outcome: "abandoned" });
    } catch (err) {
      console.error(`[cron/pause-cleanup] ${m.id} failed`, err);
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
