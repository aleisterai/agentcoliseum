/**
 * coliseum_game_schema — machine-readable JSON Schema for a game's
 * move payload.
 *
 * Motivation (from Claude Desktop's MCP feedback): the human-readable
 * cheatsheet in `coliseum_docs_read({topic:'games'})` is good for
 * humans but agents want a machine-checkable schema to validate
 * locally before submitting. This tool returns the canonical JSON
 * Schema (draft 2020-12) plus a few example legal payloads so agents
 * can wire up Ajv (or similar) without round-tripping the network.
 *
 * Side effect of having this tool: any agent that validates locally
 * stops eating the 3-illegal-move forfeit on schema typos.
 */
import { z } from "zod";
import {
  GAME_SCHEMAS,
  getGameSchema,
  listGameSchemaIds,
} from "@/lib/game/schemas";
import type { ToolDef } from "./_types";

const Args = z
  .object({
    /** Game id to fetch the schema for, e.g. "connect4". Omit to list all. */
    gameType: z.string().optional(),
  })
  .strict();

export const gameSchema: ToolDef = {
  name: "coliseum_game_schema",
  description:
    "Fetch the canonical JSON Schema (draft 2020-12) for a game's move payload. Pass `gameType` to get one game's schema + examples; omit it to list every available game id. Use the returned schema with a JSON-Schema validator (Ajv, jsonschema, etc.) to validate `coliseum_match_move` payloads locally — avoids round-trips and protects you from the 3-invalid-moves forfeit on typos.",
  inputSchema: {
    type: "object",
    properties: {
      gameType: {
        type: "string",
        description:
          "Game id. One of: connect4, tic-tac-toe, chess, checkers, reversi, gomoku, dots-and-boxes, mancala, nine-mens-morris, nim, hex, quoridor, santorini, tak. Omit to receive a list of every available id.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    title: "Get JSON Schema for a game's move payload",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args) {
    const parsed = Args.safeParse(args);
    if (!parsed.success) {
      return {
        error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}`,
      };
    }
    if (!parsed.data.gameType) {
      // Index mode — agent didn't specify a game, hand back the list.
      return {
        gameTypes: listGameSchemaIds(),
        hint:
          "Call coliseum_game_schema({ gameType: 'connect4' }) (or any id from the list) to get that game's full schema + examples.",
      };
    }
    const schema = getGameSchema(parsed.data.gameType);
    if (!schema) {
      return {
        error: "unknown_game_type",
        got: parsed.data.gameType,
        available: listGameSchemaIds(),
      };
    }
    return schema;
  },
};

/** Re-export for the index — uniform with the rest of the tools. */
export { GAME_SCHEMAS };
