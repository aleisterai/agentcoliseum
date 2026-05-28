/**
 * GET /api/cron/hosted-agent-loop
 *
 * The server-side reasoning loop for Hosted Agent Mode.
 *
 * Every minute (vercel.json), this cron:
 *   1. Finds active matches where the on-turn agent is in 'hosted'
 *      execution mode AND has an active subscription (expires_at > now).
 *   2. For each: loads the agent's voice + opponent + recent moves,
 *      decrypts the API key, builds a stateless prompt, calls the LLM,
 *      parses the response into a move, submits via applyMove.
 *   3. On per-agent error: bumps consecutive_errors. At 3 strikes,
 *      recalls the agent until the owner fixes the config.
 *
 * Why per-match loop (not per-agent): different matches have different
 * clocks. We want to play whichever match is closest to timing out
 * first. The SQL ORDER BY turn_started_at ASC handles that.
 *
 * Time pressure: the LLM call has a tight timeout (30s default; less
 * if the per-move clock is running out). If the LLM doesn't respond
 * in time, the regular timeout-games cron will eventually forfeit the
 * match — same as any other agent. Hosted agents don't get a special
 * grace period; they just have a more reliable loop than MCP agents.
 */
import { NextResponse } from "next/server";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  agents,
  matches,
  matchMoves,
  hostedAgentConfigs,
  hostedAgentSubscriptions,
} from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { authorizedCronRequest } from "@/lib/cron-auth";
import { withCronLock } from "@/lib/cron-lock";
import { recordCronRun } from "@/lib/cron-audit";
import { applyMove } from "@/lib/game/flow/match";
import { getProvider } from "@/lib/llm/registry";
import { decryptApiKey } from "@/lib/llm/encryption";
import { buildPrompt } from "@/lib/llm/prompt-builder";
import { parseMoveResponse, ResponseParseError } from "@/lib/llm/response-parser";
import { LlmError } from "@/lib/llm/types";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
// 60s max so a slow LLM provider doesn't take the function out
export const maxDuration = 60;

const BATCH_LIMIT = 10;

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  return withCronLock("hosted-agent-loop", () =>
    recordCronRun("hosted-agent-loop", async ({ setItems, setMetadata }) =>
      handle({ setItems, setMetadata }),
    ),
  );
}

interface PerMatchOutcome {
  matchId: string;
  outcome: "moved" | "skipped" | "error";
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

  // 1. Find matches where the on-turn agent is hosted + has an active
  //    subscription. We deliberately don't filter on "agent ready" /
  //    moveCount=0 here — hosted agents are always ready by definition
  //    (they don't need a separate match_state call to start the clock).
  //
  //    However, the regular agent-ready gate still applies: a fresh
  //    match's clock won't tick until SOMETHING calls match_state. We
  //    handle that inside the loop by stamping agentReadyAt + reset
  //    turnStartedAt on the first attempt.
  const activeHosted = await db
    .select({
      matchId: matches.id,
      currentTurnAgentId: matches.currentTurnAgentId,
      turnStartedAt: matches.turnStartedAt,
      moveCount: matches.moveCount,
      agentReadyAt: matches.agentReadyAt,
    })
    .from(matches)
    .innerJoin(agents, eq(agents.id, matches.currentTurnAgentId))
    .innerJoin(hostedAgentConfigs, eq(hostedAgentConfigs.agentId, agents.id))
    .where(
      and(
        eq(matches.status, "active"),
        eq(agents.executionMode, "hosted"),
        // Skip agents currently sitting at consecutive_errors >= 3 —
        // they're effectively recalled. Owner has to reset the
        // counter (via re-running the enable tool) to retry.
        // Done as a sub-condition rather than a JOIN filter so the
        // query plan stays simple.
      ),
    )
    .orderBy(asc(matches.turnStartedAt))
    .limit(BATCH_LIMIT);

  if (activeHosted.length === 0) {
    setItems(0);
    setMetadata({ moved: 0, errored: 0 });
    return NextResponse.json({ ok: true, played: 0 });
  }

  // 2. Pre-load the agent + config rows for the candidates we found.
  const agentIds = activeHosted
    .map((r) => r.currentTurnAgentId)
    .filter(Boolean) as string[];
  const [agentRows, configRows, subRows] = await Promise.all([
    db.select().from(agents).where(inArray(agents.id, agentIds)),
    db
      .select()
      .from(hostedAgentConfigs)
      .where(inArray(hostedAgentConfigs.agentId, agentIds)),
    db
      .select()
      .from(hostedAgentSubscriptions)
      .where(
        and(
          inArray(hostedAgentSubscriptions.agentId, agentIds),
          eq(hostedAgentSubscriptions.status, "active"),
          gt(hostedAgentSubscriptions.expiresAt, now),
        ),
      ),
  ]);
  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  const configById = new Map(configRows.map((c) => [c.agentId, c]));
  const subByAgent = new Set(subRows.map((s) => s.agentId));

  const results: PerMatchOutcome[] = [];

  for (const row of activeHosted) {
    const agentId = row.currentTurnAgentId;
    if (!agentId) continue;
    const config = configById.get(agentId);
    const agent = agentById.get(agentId);
    if (!config || !agent) {
      results.push({ matchId: row.matchId, outcome: "skipped", detail: "no config or agent row" });
      continue;
    }
    // Subscription gate
    if (!subByAgent.has(agentId)) {
      results.push({ matchId: row.matchId, outcome: "skipped", detail: "no active subscription" });
      continue;
    }
    // Consecutive-error gate
    if (config.consecutiveErrors >= 3) {
      results.push({ matchId: row.matchId, outcome: "skipped", detail: "errors_exceeded" });
      continue;
    }

    try {
      await playOneTurn({ matchId: row.matchId, agentId, config, agent });
      results.push({ matchId: row.matchId, outcome: "moved" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error(
        { err, matchId: row.matchId, agentId },
        "hosted-agent-loop turn failed",
      );
      // Record error against config (so owner can see + 3-strike gate fires).
      await db
        .update(hostedAgentConfigs)
        .set({
          lastError: detail.slice(0, 500),
          consecutiveErrors: config.consecutiveErrors + 1,
          updatedAt: new Date(),
        })
        .where(eq(hostedAgentConfigs.agentId, agentId));
      results.push({ matchId: row.matchId, outcome: "error", detail: detail.slice(0, 200) });
    }
  }

  const moved = results.filter((r) => r.outcome === "moved").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const errored = results.filter((r) => r.outcome === "error").length;
  setItems(moved);
  setMetadata({ moved, skipped, errored, scanned: activeHosted.length });
  return NextResponse.json({ ok: true, moved, skipped, errored, results });
}

interface PlayArgs {
  matchId: string;
  agentId: string;
  config: typeof hostedAgentConfigs.$inferSelect;
  agent: typeof agents.$inferSelect;
}

async function playOneTurn({ matchId, agentId, config, agent }: PlayArgs): Promise<void> {
  const provider = getProvider(config.llmProvider);
  if (!provider) throw new Error(`provider ${config.llmProvider} not in registry`);

  // Load match + opponent + recent moves
  const match = await db.query.matches.findFirst({ where: eq(matches.id, matchId) });
  if (!match) throw new Error("match disappeared");
  if (match.status !== "active") throw new Error("match no longer active");
  if (match.currentTurnAgentId !== agentId) throw new Error("not this agent's turn anymore");

  // First-move readiness stamp — hosted agents are implicitly "ready"
  // since the worker is reading match state on their behalf. Without
  // this stamp, the per-move clock doesn't tick on move 0 (and the
  // refund-unready-matches cron would eventually reap us).
  if (match.moveCount === 0 && !match.agentReadyAt) {
    const now = new Date();
    await db
      .update(matches)
      .set({ agentReadyAt: now, turnStartedAt: now })
      .where(eq(matches.id, matchId));
  }

  const opponentId =
    match.p1AgentId === agentId ? match.p2AgentId : match.p1AgentId;
  const opponent = opponentId
    ? await db.query.agents.findFirst({ where: eq(agents.id, opponentId) })
    : null;

  const recentMovesDesc = await db
    .select({
      moveNumber: matchMoves.moveNumber,
      playerId: matchMoves.playerId,
      payload: matchMoves.payload,
      reasoning: matchMoves.reasoning,
      say: matchMoves.say,
    })
    .from(matchMoves)
    .where(eq(matchMoves.matchId, matchId))
    .orderBy(desc(matchMoves.moveNumber))
    .limit(5);
  const recentMoves = recentMovesDesc
    .slice()
    .reverse()
    .map((m) => ({
      moveNumber: m.moveNumber,
      playerId: m.playerId as "0" | "1",
      payload: m.payload,
      reasoning: m.reasoning,
      say: m.say,
    }));

  const myPlayerId: "0" | "1" = match.p1AgentId === agentId ? "0" : "1";

  const { system, user } = buildPrompt({
    match,
    myAgent: {
      handle: agent.handle,
      displayName: agent.displayName,
      voicePackId: agent.voicePackId,
      catchphrase: agent.catchphrase,
      winLine: agent.winLine,
      lossLine: agent.lossLine,
    },
    opponent: opponent
      ? {
          handle: opponent.handle,
          displayName: opponent.displayName,
          voicePackId: opponent.voicePackId,
        }
      : null,
    myPlayerId,
    recentMoves,
    systemPromptExtra: config.systemPromptExtra,
  });

  // Decrypt the API key only in this narrow scope. The plaintext
  // never leaves this stack frame.
  const apiKey = decryptApiKey({
    ciphertext: config.apiKeyEncrypted,
    iv: config.apiKeyIv,
    tag: config.apiKeyTag,
  });

  // Tight timeout: 30s OR half the per-move clock budget, whichever
  // is smaller. Leaves time for parsing + DB submit.
  const timeoutMs = Math.min(30_000, Math.floor(match.clockBudgetMs * 0.5));

  const start = Date.now();
  let result;
  try {
    result = await provider.call({
      apiKey,
      model: config.llmModel,
      system,
      user,
      maxOutputTokens: 2000,
      timeoutMs,
    });
  } catch (err) {
    if (err instanceof LlmError) {
      throw new Error(`LLM ${err.kind}: ${err.message}`);
    }
    throw err;
  }
  const thinkingMs = Math.max(50, Date.now() - start);

  // Parse + submit
  let parsed;
  try {
    parsed = parseMoveResponse(result.text);
  } catch (err) {
    if (err instanceof ResponseParseError) {
      throw new Error(`parse failed: ${err.message}; snippet: ${err.rawSnippet.slice(0, 200)}`);
    }
    throw err;
  }

  await applyMove({
    matchId,
    agentId,
    payload: parsed.payload,
    reasoning: parsed.reasoning,
    say: parsed.say,
    reactingTo: {
      ref: parsed.reactingTo.ref as
        | "opponent_move"
        | "opponent_chat"
        | "their_plan"
        | "nothing_yet",
      echo: parsed.reactingTo.echo ?? "",
    },
    thinkingMs,
  });

  // Reset error counter on successful move
  await db
    .update(hostedAgentConfigs)
    .set({
      consecutiveErrors: 0,
      lastError: null,
      lastCallAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(hostedAgentConfigs.agentId, agentId));
}
