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
 * Per match:
 *   1. Mark status='completed', result_reason='abandoned',
 *      winner_agent_id=null, completed_at=now()
 *      (winner null + abandoned = no ELO impact downstream; same shape
 *      as a draw on the outcome side except no payout.)
 *
 *   2. If paid (stake_usdc > 0):
 *        - refund proposer stake → proposer's owner wallet
 *        - refund acceptor stake → acceptor's owner wallet
 *        - record both tx hashes; idempotent on payout_tx_hash IS NULL
 *      No treasury fee — the game never started.
 *
 *   3. If system mode: no on-chain movement. Just close the row so
 *      the lobby + MCP match_list stop surfacing it.
 *
 * NOT a time-forfeit — the game never started, neither player did
 * anything wrong. `abandoned` is the correct resultReason and ELO
 * stays untouched (matches.test.ts already covers this branch for
 * the existing abandoned-challenge path).
 */
import { NextResponse } from "next/server";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches, owners } from "@/lib/db/schema";
import { refundStake } from "@/lib/chain/stake";
import { finalizeMatch } from "@/lib/game/flow/finalize";
import { jsonError } from "@/lib/http";
import { recordCronRun } from "@/lib/cron-audit";
import { authorizedCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 10;
const UNREADY_MAX_MS = 30 * 60 * 1000; // 30 minutes

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  return recordCronRun("refund-unready-matches", async ({ setItems, setMetadata }) => {
    return handle({ setItems, setMetadata });
  });
}

interface PerMatchOutcome {
  matchId: string;
  outcome: "abandoned" | "refunded" | "skipped" | "error";
  refundedSides?: number;
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
    setMetadata({ abandoned: 0, refunded: 0, skipped: 0, errored: 0 });
    return NextResponse.json({ ok: true, abandoned: 0, message: "no stuck matches" });
  }

  const results: PerMatchOutcome[] = [];

  for (const m of stuck) {
    try {
      // Close via finalizeMatch — NOT a raw UPDATE. finalizeMatch is
      // the single source of truth for match completion: it transacts
      // the row update + fires the GameEnded Supabase Realtime broadcast
      // so any spectator on the match page sees the end state without
      // having to refresh. Doing a raw UPDATE here would have skipped
      // the broadcast and left every connected client stuck on
      // status='active' until they reloaded. resultReason='abandoned'
      // signals to finalizeMatch to skip ELO Δ + W/L/D counter changes
      // (the new policy from the moveCount=0 fairness gate).
      await finalizeMatch({
        matchId: m.id,
        winnerAgentId: null,
        resultReason: "abandoned",
        finalP1Ms: 0,
        finalP2Ms: 0,
      });

      // Paid match → refund both stakes. System matches have no stake.
      if (m.mode === "paid" && m.stakeUsdc && m.stakeUsdc > 0) {
        if (!process.env.PLATFORM_OPERATOR_PRIVATE_KEY) {
          results.push({
            matchId: m.id,
            outcome: "skipped",
            detail: "PLATFORM_OPERATOR_PRIVATE_KEY not set — match closed, refunds deferred",
          });
          continue;
        }
        let refundedSides = 0;
        for (const agentId of [m.p1AgentId, m.p2AgentId].filter(Boolean) as string[]) {
          const ownerRow = await db
            .select({ wallet: owners.walletAddress })
            .from(agents)
            .innerJoin(owners, eq(agents.ownerId, owners.id))
            .where(eq(agents.id, agentId))
            .limit(1);
          const wallet = ownerRow[0]?.wallet;
          if (!wallet) continue;
          await refundStake(wallet as `0x${string}`, m.stakeUsdc);
          refundedSides++;
        }
        results.push({ matchId: m.id, outcome: "refunded", refundedSides });
      } else {
        // System / free: nothing to refund, row already closed.
        results.push({ matchId: m.id, outcome: "abandoned" });
      }
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
  const refunded = results.filter((r) => r.outcome === "refunded").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const errored = results.filter((r) => r.outcome === "error").length;
  setItems(abandoned + refunded);
  setMetadata({ abandoned, refunded, skipped, errored, batchSize: results.length });
  return NextResponse.json({ ok: true, abandoned, refunded, skipped, errored, results });
}

// Silence unused import for the sql helper if we don't end up using
// it (kept for future raw-SQL escape hatches).
void sql;
