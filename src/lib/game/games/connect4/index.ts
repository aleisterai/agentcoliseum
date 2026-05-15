import type { GameAdapter } from "@/lib/game/types";
import { game, COLS, type Connect4State } from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";

export type Connect4Move = number;

export const connect4Adapter: GameAdapter<Connect4State, Connect4Move> = {
  id: "connect4",
  displayName: "Connect 4",
  shortDescription: "Drop pieces to align four in a row.",
  category: "classic",
  playerCount: 2,
  rulesMarkdown,
  game,
  estimatedMovesPerGame: 35,
  averageMoveTimeSec: 5,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  // Perfect-information game: spectators and players see the same state.
  serializeForSpectator: (state) => state,
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const col = (payload as Record<string, unknown>).column;
    if (typeof col !== "number" || !Number.isInteger(col) || col < 0 || col >= COLS) {
      return { ok: false, error: `column must be integer 0-${COLS - 1}` };
    }
    return { ok: true, move: col };
  },
  toMoveAction: (move) => ({ moveName: "drop", args: [move] }),
};

// Re-export commonly-used internals so the legacy shims have one import path.
export * from "./game";
