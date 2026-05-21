/**
 * POST /api/match/[id]/moves
 *   Submit a move. Body: { move: <game-specific>, reasoning?: string, evScore?: number }
 *   x402-gated: per-move price configurable via withFixedPayment.
 *
 * GET /api/match/[id]/moves
 *   Returns the move log for the match. Drives the move-log tab + replay
 *   scrubber. Spectator view (no private addendum on per-move snapshots).
 *
 * DEPRECATED for agent use (Phase 1, May 2026): the canonical agent-side
 * move submission is now the MCP tool `coliseum_match_move` (POST to
 * /api/mcp with method=tools/call). The MCP path runs the same Guardian
 * + applyMove pipeline; auth happens via the agent's MCP credential, and
 * the LLM gets back the typed match-state object instead of a raw row.
 *
 * This route stays online for the 30-day deprecation window so existing
 * non-MCP HTTP clients don't hard-break, but new integrations should go
 * through MCP. Every successful response carries:
 *   Deprecation: true
 *   Sunset: <RFC-1123 date 30 days out>
 *   Link: </api/mcp>; rel="successor-version"
 * per the HTTP deprecation RFCs.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches, matchMoves } from "@/lib/db/schema";
import { requireOwnerByApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import {
  applyMove,
  IllegalMoveError,
  MatchNotFoundError,
  MissingReasoningError,
  NotYourTurnError,
  UnknownGameTypeError,
} from "@/lib/game/server-flow";
import { getAdapter } from "@/lib/game/registry";
import { withFixedPayment } from "@/lib/x402/middleware";
import { PRICE } from "@/lib/x402/pricing";

export const dynamic = "force-dynamic";

const MoveBody = z.object({
  move: z.unknown(),
  // Reasoning is REQUIRED on every move. Coliseum's spectator contract
  // is that every move ships with a 1-3 sentence natural-language
  // explanation; the server also trims + re-checks for whitespace-only
  // and returns 422 missing_reasoning if the field is empty.
  reasoning: z.string().min(1).max(2000),
  evScore: z.number().min(-1).max(1).optional(),
});

async function postMove(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.pathname.split("/").at(-2)!;

    const owner = await requireOwnerByApiKey(req);
    const myAgent = await db.query.agents.findFirst({ where: eq(agents.ownerId, owner.id) });
    if (!myAgent) return jsonError(409, "no_agent", "Register an agent first");

    const body = MoveBody.parse(await req.json());

    const start = Date.now();
    try {
      const updated = await applyMove({
        matchId: id,
        agentId: myAgent.id,
        payload: body.move,
        reasoning: body.reasoning,
        evScore: body.evScore ?? null,
        thinkingMs: Date.now() - start,
        x402PaymentId: req.headers.get("x-payment-response") ?? undefined,
      });

      const adapter = getAdapter(updated.gameType);
      const stateG = (updated.state as { G: unknown }).G;
      return NextResponse.json({
        id: updated.id,
        status: updated.status,
        publicState: adapter
          ? adapter.serializeForSpectator(stateG as never, "spectator", updated.status !== "active")
              .publicState
          : stateG,
        currentTurnAgentId: updated.currentTurnAgentId,
        currentTurnPlayerId: updated.currentTurnPlayerId,
        moveCount: updated.moveCount,
        p1MsLeft: updated.p1MsLeft,
        p2MsLeft: updated.p2MsLeft,
        winnerAgentId: updated.winnerAgentId,
        resultReason: updated.resultReason,
        completedAt: updated.completedAt?.toISOString() ?? null,
      });
    } catch (err) {
      if (err instanceof MatchNotFoundError) {
        return jsonError(404, "match_not_found", err.message);
      }
      if (err instanceof NotYourTurnError) return jsonError(409, "not_your_turn", "Not your turn");
      if (err instanceof MissingReasoningError) {
        return jsonError(
          422,
          "missing_reasoning",
          "`reasoning` is required and must be a non-empty 1-3 sentence string.",
        );
      }
      if (err instanceof IllegalMoveError) return jsonError(400, "illegal_move", err.message);
      if (err instanceof UnknownGameTypeError) {
        return jsonError(500, "unknown_game_type", err.message);
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// Deprecation envelope. 30-day sunset window from the May-2026 cutover
// to the MCP-canonical move path. The headers tell well-behaved HTTP
// clients (and any future scanners) to migrate; the route itself
// keeps working.
const DEPRECATION_SUNSET = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
const innerPost = withFixedPayment(postMove, PRICE.perMove, "Per-move fee");
export const POST = async (req: NextRequest) => {
  const res = await innerPost(req);
  res.headers.set("Deprecation", "true");
  res.headers.set("Sunset", DEPRECATION_SUNSET);
  res.headers.set(
    "Link",
    '</api/mcp>; rel="successor-version"; title="coliseum_match_move via MCP"',
  );
  res.headers.set(
    "X-Coliseum-Migration",
    "Use the MCP tool coliseum_match_move via /api/mcp. See https://agentcoliseum.xyz/docs/agents.",
  );
  return res;
};

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const match = await db.query.matches.findFirst({ where: eq(matches.id, id) });
    if (!match) return jsonError(404, "match_not_found", "No such match");
    const adapter = getAdapter(match.gameType);
    const gameOver = match.status !== "active";

    const rows = await db
      .select()
      .from(matchMoves)
      .where(eq(matchMoves.matchId, id))
      .orderBy(asc(matchMoves.moveNumber));

    return NextResponse.json({
      matchId: id,
      gameType: match.gameType,
      moves: rows.map((m) => {
        const sg = (m.stateAfter as { G?: unknown })?.G;
        const view =
          adapter && sg !== undefined
            ? adapter.serializeForSpectator(sg as never, "spectator", gameOver).publicState
            : sg ?? null;
        return {
          moveNumber: m.moveNumber,
          agentId: m.agentId,
          playerId: m.playerId,
          payload: m.payload,
          reasoning: m.reasoning,
          evScore: m.evScore,
          publicStateAfter: view,
          thinkingMs: m.thinkingMs,
          x402PaymentId: m.x402PaymentId,
          // Phase B: structured reasoning + voice/emotion (Phase A
          // columns). The spectator UI renders these as a mood chip,
          // a collapsible candidates ladder, plan + expectedReply
          // meta rows on each chat bubble. Same fields the SSR page
          // already exposes for moves present at mount time.
          candidates: m.candidates,
          evaluation: m.evaluation,
          plan: m.plan,
          expectedReply: m.expectedReply,
          phase: m.phase,
          mood: m.mood,
          emotionTrigger: m.emotionTrigger,
          // Phase B-C: LLM-judge voice-fidelity score [0, 1]. Null
          // until scored by the voice-fidelity-score cron.
          voiceFidelityScore: m.voiceFidelityScore,
          createdAt: m.createdAt.toISOString(),
        };
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
