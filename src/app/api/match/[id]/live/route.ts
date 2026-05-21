/**
 * GET /api/match/[id]/live?sinceMove=N
 *
 * Polling-fallback companion to the realtime broadcast channel
 * `match:{id}`. Returns the current match snapshot plus only the moves
 * newer than `sinceMove` (defaulting to -1 = "everything"). The client
 * polls this every few seconds while in live mode so a dropped or
 * stalled broadcast can't freeze the board.
 *
 * Public, idempotent, force-dynamic. No auth — same threat model as the
 * existing /api/match/[id] route.
 */
import { NextResponse } from "next/server";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matches, matchMoves } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";
import { getAdapter } from "@/lib/game/registry";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const sinceMoveRaw = url.searchParams.get("sinceMove");
    const sinceMove = sinceMoveRaw == null ? -1 : Number.parseInt(sinceMoveRaw, 10);
    if (sinceMoveRaw != null && !Number.isFinite(sinceMove)) {
      return jsonError(400, "bad_request", "sinceMove must be an integer");
    }

    const match = await db.query.matches.findFirst({ where: eq(matches.id, id) });
    if (!match) return jsonError(404, "match_not_found", `Match ${id} does not exist`);

    const adapter = getAdapter(match.gameType);
    const gameOver = match.status !== "active";

    // Only fetch moves the client hasn't seen yet. moveNumber is 0-based;
    // the highest moveNumber in moves[] is `moves.length - 1`. So the
    // client passes `sinceMove = moves.length - 1` to skip already-seen
    // rows; the first-ever poll passes -1 (or omits the param) and gets
    // everything (which the client de-dupes).
    const moves = await db
      .select()
      .from(matchMoves)
      .where(and(eq(matchMoves.matchId, id), gt(matchMoves.moveNumber, sinceMove)))
      .orderBy(asc(matchMoves.moveNumber));

    return NextResponse.json({
      id: match.id,
      gameType: match.gameType,
      status: match.status,
      currentTurnAgentId: match.currentTurnAgentId,
      currentTurnPlayerId: match.currentTurnPlayerId,
      turnStartedAt: match.turnStartedAt.toISOString(),
      p1MsLeft: match.p1MsLeft,
      p2MsLeft: match.p2MsLeft,
      moveCount: match.moveCount,
      winnerAgentId: match.winnerAgentId,
      resultReason: match.resultReason,
      completedAt: match.completedAt?.toISOString() ?? null,
      lastMoveAt: match.lastMoveAt?.toISOString() ?? null,
      // Moves the client doesn't have yet. Empty array = caught up.
      moves: moves.map((m) => {
        const stateAfterG = (m.stateAfter as { G?: unknown } | null)?.G ?? null;
        // Run through the adapter's spectator filter so a future
        // imperfect-info game (e.g. hidden hands) doesn't leak state.
        // Perfect-info games (every game we ship today) return G as-is.
        const view =
          adapter && stateAfterG !== null
            ? adapter.serializeForSpectator(stateAfterG as never, "spectator", gameOver)
                .publicState
            : stateAfterG;
        return {
          moveNumber: m.moveNumber,
          agentId: m.agentId,
          playerId: m.playerId,
          payload: m.payload,
          stateAfterG: view,
          reasoning: m.reasoning,
          evScore: m.evScore,
          thinkingMs: m.thinkingMs,
          x402PaymentId: m.x402PaymentId,
          // Phase B: structured reasoning + voice/emotion. Persisted
          // by Phase A in match_moves; surface them on the spectator
          // wire so the chat panel can render mood chips + candidates
          // ladders for moves that arrived after page mount (polling
          // or WS catch-up). SSR snapshot in page.tsx already includes
          // them for moves present at mount time.
          candidates: m.candidates,
          evaluation: m.evaluation,
          plan: m.plan,
          expectedReply: m.expectedReply,
          phase: m.phase,
          mood: m.mood,
          emotionTrigger: m.emotionTrigger,
          // Phase B-C: server-side LLM judge score [0, 1]. Null until
          // the voice-fidelity-score cron sweeps it. UI renders a
          // small voice-tinted dot next to the mood chip when set.
          voiceFidelityScore: m.voiceFidelityScore,
          createdAt: m.createdAt.toISOString(),
        };
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
