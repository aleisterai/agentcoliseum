/**
 * GET /api/cron/voice-fidelity-score
 *
 * Phase B-C: scans match_moves for rows still missing
 * `voice_fidelity_score`, sends each one's reasoning + the agent's
 * voice pack templates to the Claude judge, writes the 0-1 score
 * back. Runs every minute (vercel.json) but bounded to a small batch
 * so a backlog can't spike Anthropic API cost.
 *
 * Eligibility filter:
 *   voice_fidelity_score IS NULL
 *   AND reasoning IS NOT NULL AND reasoning != ''
 *   AND agent_id IS NOT NULL  (system bot moves have no voice pack)
 *
 * Per row:
 *   1. Look up the agent's voice pack fields (cheap — single FK lookup)
 *   2. Call judge.judgeVoiceFidelity({...})
 *   3. If the judge returned null (no API key set, network blip, etc.)
 *      we leave the row unscored — the next sweep retries. No
 *      negative caching: an empty key today might be filled in
 *      tomorrow and we want the backlog to drain immediately.
 *   4. Otherwise write the score. Idempotent on
 *      voice_fidelity_score IS NULL so two crons firing in the same
 *      minute can't double-bill the judge API.
 *
 * Cost ceiling: BATCH_LIMIT = 10 per minute * 60 minutes * 24 hours
 * = 14,400 calls/day max even at backlog saturation. Claude Haiku at
 * ~$0.001 per call is ~$14/day, well inside the test plan's budget
 * for an MVP. Lower BATCH_LIMIT if cost starts to bite.
 */
import { NextResponse } from "next/server";
import { and, eq, isNull, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matchMoves } from "@/lib/db/schema";
import { judgeVoiceFidelity } from "@/lib/voice-fidelity/judge";
import { jsonError } from "@/lib/http";
import { recordCronRun } from "@/lib/cron-audit";
import { authorizedCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 10;

interface PerRowOutcome {
  moveId: string;
  outcome: "scored" | "skipped" | "error";
  score?: number;
  detail?: string;
}

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  return recordCronRun("voice-fidelity-score", async ({ setItems, setMetadata }) => {
    return handle({ setItems, setMetadata });
  });
}

async function handle({
  setItems,
  setMetadata,
}: {
  setItems: (n: number) => void;
  setMetadata: (m: Record<string, unknown>) => void;
}) {
  // Eligibility: unscored move with prose + an agent (so we have
  // voice pack context). System-bot moves have no agent row and
  // therefore no voice pack — skip those in the SQL filter rather
  // than calling the judge for nothing.
  const rows = await db
    .select({
      id: matchMoves.id,
      reasoning: matchMoves.reasoning,
      agentId: matchMoves.agentId,
    })
    .from(matchMoves)
    .where(
      and(
        isNull(matchMoves.voiceFidelityScore),
        isNotNull(matchMoves.reasoning),
        ne(matchMoves.reasoning, ""),
        isNotNull(matchMoves.agentId),
      ),
    )
    .limit(BATCH_LIMIT);

  if (rows.length === 0) {
    setItems(0);
    setMetadata({ scored: 0, skipped: 0, errored: 0 });
    return NextResponse.json({ ok: true, scored: 0, message: "no unscored moves" });
  }

  const results: PerRowOutcome[] = [];

  for (const r of rows) {
    try {
      // Pull the agent's voice pack context. Could be batched, but the
      // batch ceiling is 10/min — a single query per row is fine.
      const agent = await db.query.agents.findFirst({
        where: eq(agents.id, r.agentId!),
        columns: {
          voicePackId: true,
          catchphrase: true,
          winLine: true,
          lossLine: true,
          trashTalkTemplates: true,
        },
      });
      if (!agent || !agent.voicePackId) {
        results.push({ moveId: r.id, outcome: "skipped", detail: "no voicePackId" });
        continue;
      }
      const judge = await judgeVoiceFidelity({
        reasoning: r.reasoning!,
        voicePackId: agent.voicePackId,
        catchphrase: agent.catchphrase,
        winLine: agent.winLine,
        lossLine: agent.lossLine,
        trashTalkTemplates: (agent.trashTalkTemplates as string[] | null) ?? null,
      });
      if (judge.score == null) {
        // Judge couldn't produce a score (no API key, transient API
        // failure, or malformed response). Don't write; next sweep
        // retries the row. No retry counter — Claude Haiku failures
        // are typically transient and the cost of a few extra calls
        // is negligible vs. the complexity of tracking per-row
        // retry state.
        results.push({
          moveId: r.id,
          outcome: "skipped",
          detail: "judge returned null",
        });
        continue;
      }
      // Idempotent write: only update if still NULL so two concurrent
      // crons can't double-write.
      await db
        .update(matchMoves)
        .set({ voiceFidelityScore: judge.score })
        .where(and(eq(matchMoves.id, r.id), isNull(matchMoves.voiceFidelityScore)));
      results.push({ moveId: r.id, outcome: "scored", score: judge.score });
    } catch (err) {
      console.error(`[cron/voice-fidelity-score] ${r.id} failed`, err);
      results.push({
        moveId: r.id,
        outcome: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const scored = results.filter((r) => r.outcome === "scored").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const errored = results.filter((r) => r.outcome === "error").length;
  setItems(scored);
  setMetadata({ scored, skipped, errored, batchSize: results.length });
  return NextResponse.json({ ok: true, scored, skipped, errored, results });
}
