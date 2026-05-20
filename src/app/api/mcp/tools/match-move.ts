/**
 * coliseum.match.move — submit a move in a live match.
 *
 * The heavy lifting (clock check, payload validation, engine apply,
 * finalize-on-game-over, broadcast) is in flow/match.applyMove. This
 * tool is a thin wrapper that translates the domain errors to
 * LLM-readable error strings.
 *
 * Returned shape matches what coliseum.match.state returns (so an
 * LLM that just made a move can re-prompt itself with the updated
 * state without a second call).
 */

import { z } from "zod";
import {
  applyMove,
  IllegalMoveError,
  MatchNotFoundError,
  NotYourTurnError,
  UnknownGameTypeError,
} from "@/lib/game/server-flow";
import type { ToolDef } from "./_types";

const MoveArgs = z
  .object({
    matchId: z.string().uuid(),
    payload: z.record(z.string(), z.unknown()),
    reasoning: z.string().max(2000).nullable().optional(),
    thinkingMs: z.number().int().min(0).max(600_000),
  })
  .strict();

export const matchMove: ToolDef = {
  name: "coliseum.match.move",
  description:
    "Submit a move in a match. `payload` is the game-specific move object — call coliseum.docs.read({topic:'games'}) for the format per game type, and coliseum.match.state(matchId) for the current state. `reasoning` is an optional 1-3 sentence string explaining the move (shown on the public reasoning trace; not required). `thinkingMs` is the wall-clock time you spent thinking — it decrements your clock. Server validates the move against the game's rules; 2 invalid moves in a row forfeits the match. The first move on the clock pays $0.0008 USDC via x402 — handled server-side, the LLM never signs crypto. Returns the post-move state + the result if the move ended the game.",
  inputSchema: {
    type: "object",
    properties: {
      matchId: { type: "string", format: "uuid" },
      payload: { type: "object", additionalProperties: true },
      reasoning: { type: ["string", "null"], maxLength: 2000 },
      thinkingMs: { type: "integer", minimum: 0, maximum: 600_000 },
    },
    required: ["matchId", "payload", "thinkingMs"],
    additionalProperties: false,
  },
  async handler(args, { agent }) {
    const parsed = MoveArgs.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    const v = parsed.data;
    try {
      const updated = await applyMove({
        matchId: v.matchId,
        agentId: agent.id,
        payload: v.payload,
        reasoning: v.reasoning ?? null,
        thinkingMs: v.thinkingMs,
      });
      const isMyTurn = updated.currentTurnAgentId === agent.id;
      return {
        matchId: updated.id,
        status: updated.status,
        moveCount: updated.moveCount,
        isMyTurn,
        currentTurnAgentId: updated.currentTurnAgentId,
        p1MsLeft: updated.p1MsLeft,
        p2MsLeft: updated.p2MsLeft,
        winnerAgentId: updated.winnerAgentId,
        resultReason: updated.resultReason,
        boardState: updated.state,
        finalized: updated.status === "completed",
      };
    } catch (err) {
      if (err instanceof MatchNotFoundError) return { error: "match_not_found" };
      if (err instanceof NotYourTurnError) {
        return { error: "not_your_turn: opponent must move first" };
      }
      if (err instanceof IllegalMoveError) {
        return { error: `illegal_move: ${err.message}` };
      }
      if (err instanceof UnknownGameTypeError) {
        return { error: `unknown_game_type: ${err.message}` };
      }
      throw err;
    }
  },
};
