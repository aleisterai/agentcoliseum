/**
 * movers.ts — per-game adapter callers.
 *
 * One responsibility: given a gameType + the boardState returned by
 * `/api/v1/match/state` + the agent's playerID ("0" or "1"), pick a
 * legal move from the adapter's easy bot AND encode it into the
 * wire-payload shape that `coliseum_match_move` accepts.
 *
 * Why a separate "encoder" step?
 *   - TTT bots return a bare `number` (cell index 0-8) → wire shape is
 *     `{ index: n }`.
 *   - Connect4 bots return a bare `number` (column 0-6) → wire shape
 *     is `{ column: n }`.
 *   - All other adapters (chess, checkers, reversi, gomoku, dots-and-
 *     boxes, mancala, nine-mens-morris, nim, hex, quoridor, santorini,
 *     tak) return move objects whose internal shape ALREADY matches
 *     the wire payload one-to-one. For those the encoder is identity.
 *
 * The full list mirrors `getAdapter(gameType).validateMovePayload`
 * inverted — see scripts/sim/README.md for the schema per game.
 */

import { getAdapter } from "@/lib/game/registry";
import type { BotDifficulty } from "@/lib/game/types";

export type GameId =
  | "tic-tac-toe"
  | "connect4"
  | "chess"
  | "checkers"
  | "reversi"
  | "gomoku"
  | "dots-and-boxes"
  | "mancala"
  | "nine-mens-morris"
  | "nim"
  | "hex"
  | "quoridor"
  | "santorini"
  | "tak";

export const ALL_GAMES: GameId[] = [
  "tic-tac-toe",
  "connect4",
  "chess",
  "checkers",
  "reversi",
  "gomoku",
  "dots-and-boxes",
  "mancala",
  "nine-mens-morris",
  "nim",
  "hex",
  "quoridor",
  "santorini",
  "tak",
];

export type WirePayload = Record<string, unknown>;

/**
 * Encode the bot's internal move into the wire shape.
 *
 * Internal types per game — confirmed by reading src/lib/game/games/*:
 *   tic-tac-toe → number              → { index }
 *   connect4    → number              → { column }
 *   chess       → { from, to, ?promotion }  → identity (string squares)
 *   checkers    → { from, path }      → identity
 *   reversi     → { row, col }        → identity
 *   gomoku      → { row, col }        → identity
 *   dots-boxes  → { type, row, col }  → identity
 *   mancala     → { pit }             → identity
 *   nmm         → { from, to, ?remove } → identity
 *   nim         → { pile, take }      → identity
 *   hex         → { row, col }        → identity
 *   quoridor    → { kind, ?to, ?wall} → identity
 *   santorini   → { builder, to, build } → identity
 *   tak         → { to, kind }        → identity
 */
function encode(gameType: GameId, internal: unknown): WirePayload {
  if (gameType === "tic-tac-toe") {
    if (typeof internal !== "number") {
      throw new Error(
        `tic-tac-toe encoder: expected number, got ${typeof internal}`,
      );
    }
    return { index: internal };
  }
  if (gameType === "connect4") {
    if (typeof internal !== "number") {
      throw new Error(
        `connect4 encoder: expected number, got ${typeof internal}`,
      );
    }
    return { column: internal };
  }
  // Identity for the other 12 — the adapter's internal type IS the wire
  // payload shape (confirmed by reading each game's validateMovePayload).
  if (typeof internal !== "object" || internal === null) {
    throw new Error(
      `${gameType} encoder: expected object move, got ${typeof internal}`,
    );
  }
  return internal as WirePayload;
}

/**
 * Pick a legal move using the adapter's bot at the given difficulty,
 * then encode to wire shape.
 *
 * `boardState` should be the `boardState` field returned by
 * `/api/v1/match/state` — that's the full game-specific state object
 * (e.g. `{ board, turn, ... }`).
 *
 * `myPlayerID` is the `myPlayerId` field returned by match/state ("0"
 * or "1"). The adapter bots use this to pick the right side.
 */
export function pickAndEncode(
  gameType: GameId,
  boardState: unknown,
  myPlayerID: "0" | "1",
  difficulty: BotDifficulty = "easy",
): { internal: unknown; payload: WirePayload } {
  const adapter = getAdapter(gameType);
  if (!adapter) {
    throw new Error(`unknown gameType '${gameType}'`);
  }
  const bot = adapter.bots[difficulty];
  if (!bot) {
    throw new Error(`game ${gameType} has no ${difficulty} bot`);
  }
  const internal = bot.pickMove(boardState, myPlayerID);
  const payload = encode(gameType, internal);
  return { internal, payload };
}

/**
 * Construct an intentionally-broken payload for the "illegal move" /
 * "submit garbage 3x" scenarios. Each game's empty object should be
 * rejected by validateMovePayload (sweep test confirms this).
 */
export function brokenPayload(): WirePayload {
  return {};
}
