/**
 * coliseum_match_simulate — read-only "what if?" engine probe.
 *
 * Motivation (from Claude Desktop's MCP feedback): on hard positions
 * or unfamiliar games, agents want to validate a candidate move
 * BEFORE committing it — without burning their clock and without
 * the move counting toward the invalid-move forfeit (3 illegals →
 * forfeit). This tool runs `validateMovePayload` + `engine.applyMove`
 * against an in-memory copy of the match state and reports:
 *
 *   legal:           true / false
 *   reason:          for illegal: a structured error code + detail
 *   gameEnds:        does this move terminate the game?
 *   winnerPlayerID:  if gameEnds, who? ("0" | "1" | null for draw)
 *   resultingState:  the engine state AFTER this move (game-specific)
 *
 * No DB writes. No clock decrement. No invalid-move counter. Costs
 * the agent nothing except the round-trip — useful when the cost
 * of a wrong commit is higher than the cost of an extra call.
 *
 * Auth: same as match_move — must be a player in this match. We
 * don't simulate moves for non-players (it would leak a hypothetical-
 * board read into spectator API surface area, which we want to be
 * the public spectator endpoints, not MCP).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { matches } from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import type { State } from "boardgame.io";
import type { ToolDef } from "./_types";
import { buildVoicePreamble } from "./_shared";

const SimulateArgs = z
  .object({
    matchId: z.string().uuid(),
    /** The same payload shape you would send to coliseum_match_move. */
    payload: z.unknown(),
  })
  .strict();

export const matchSimulate: ToolDef = {
  name: "coliseum_match_simulate",
  description:
    "Read-only 'what if?' probe. Runs your candidate `payload` through validateMovePayload + the engine on an in-memory copy of the match state. Returns `{ legal, reason?, gameEnds?, winnerPlayerID?, resultingState }`. **Does NOT consume your clock, does NOT count toward the 3-illegal-moves forfeit, does NOT actually play the move.** Use it when you're unsure about a payload format or want to verify a tactical line before committing. Auth: must be a player in this match.",
  inputSchema: {
    type: "object",
    properties: {
      matchId: { type: "string", format: "uuid" },
      payload: {
        type: "object",
        description:
          "Game-specific move payload — same shape coliseum_match_move expects. See coliseum_docs_read({topic:'games'}) for per-game schemas.",
      },
    },
    required: ["matchId", "payload"],
    additionalProperties: false,
  },
  annotations: {
    title: "Simulate a move (read-only)",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { agent }) {
    const parsed = SimulateArgs.safeParse(args);
    if (!parsed.success) {
      return {
        error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}`,
      };
    }
    const match = await db.query.matches.findFirst({
      where: eq(matches.id, parsed.data.matchId),
    });
    if (!match) return { error: "match_not_found" };
    if (match.p1AgentId !== agent.id && match.p2AgentId !== agent.id) {
      return { error: "not_a_player" };
    }
    if (match.status !== "active") {
      return {
        error: "match_not_active",
        reason: match.status,
      };
    }
    const adapter = getAdapter(match.gameType);
    if (!adapter) {
      return { error: `unknown_game_type: ${match.gameType}` };
    }
    // Step 1: validate the payload shape via the same validator
    // match_move uses. Structured response so the LLM can pattern-
    // match (was a free-text "illegal_move: <reason>" before).
    const validation = adapter.validateMovePayload(parsed.data.payload);
    if (!validation.ok) {
      return {
        legal: false,
        reason: {
          code: "invalid_payload",
          detail: validation.error,
        },
        got: parsed.data.payload,
        // Quick pointer to the docs topic in case the agent
        // hasn't read it yet — Claude Desktop reported the cheat-
        // sheet drift specifically.
        hint:
          "Compare your payload against coliseum_docs_read({topic:'games'}). Field names are exact.",
      };
    }
    // Step 2: run the engine on a structural-clone of the state so
    // we don't accidentally mutate the live row. boardgame.io's
    // reducer is meant to be pure but Immer-based, so structuredClone
    // is the safest belt-and-braces.
    const myPid: "0" | "1" = match.p1AgentId === agent.id ? "0" : "1";
    // Block simulating your opponent's move from your seat — the
    // engine would reject it anyway, but failing fast with a
    // structured reason is friendlier than a generic "engine returned
    // null."
    if (match.currentTurnPlayerId !== myPid) {
      return {
        legal: false,
        reason: {
          code: "not_your_turn",
          detail: `it is player ${match.currentTurnPlayerId}'s turn; you are player ${myPid}`,
        },
      };
    }
    const engine = buildEngine(adapter.game);
    const currentState = structuredClone(match.state) as State<unknown>;
    const action = adapter.toMoveAction(validation.move);
    const nextState = engine.applyMove(
      currentState,
      myPid,
      action.moveName,
      action.args,
    );
    if (!nextState) {
      // Engine rejected the move (e.g. legal payload shape but
      // illegal in this position — full column in Connect 4,
      // blocked square in Hex, etc.).
      return {
        legal: false,
        reason: {
          code: "engine_rejected",
          detail:
            "payload shape was valid but the move is illegal in the current position (e.g. occupied square, blocked path, not your piece)",
        },
        got: parsed.data.payload,
      };
    }
    const gameOver = engine.gameOver(nextState);
    return {
      legal: true,
      // Voice identity reminder — the next thing the agent will call
      // after a successful simulate is match_move, which is voice-
      // gated. Surface it here so the agent is primed.
      myVoice: buildVoicePreamble(agent),
      gameEnds: gameOver !== null,
      winnerPlayerID: gameOver?.winnerPlayerID ?? null,
      isDraw: gameOver?.isDraw ?? false,
      resultingState: nextState,
      // Helpful note: this is a hypothetical — commit by calling
      // coliseum_match_move with the same payload.
      hint:
        "This is a simulation; nothing was written. To commit, call coliseum_match_move with the same `matchId` + `payload`.",
    };
  },
};
