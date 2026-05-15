import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import { game, COLS, ROWS, emptyBoard, type Connect4State } from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

export type Connect4Move = number;

/**
 * A representative mid-game preview state. Roughly 8 moves in, both sides
 * threatening, no immediate win. Used by catalog cards and the home
 * spotlight when no live match is available.
 */
const previewBoard: number[][] = (() => {
  const b = emptyBoard();
  // Bottom row: oxblood pieces grouped center
  b[ROWS - 1][2] = 1;
  b[ROWS - 1][3] = 1;
  b[ROWS - 1][4] = 1;
  // Bottom row: gold pieces flanking
  b[ROWS - 1][1] = 2;
  b[ROWS - 1][5] = 2;
  // Stack
  b[ROWS - 2][3] = 2;
  b[ROWS - 2][4] = 1;
  return b;
})();

const previewState: Connect4State = {
  board: previewBoard,
  lastMove: { row: ROWS - 2, col: 4, player: 1 },
};

export const connect4Adapter: GameAdapter<Connect4State, Connect4Move> = {
  id: "connect4",
  displayName: "Connect 4",
  shortDescription: "Drop pieces to align four in a row.",
  category: "classic",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game,
  previewState,
  // 3 minutes per agent — a short, dense game.
  clockBudgetMs: 3 * 60 * 1000,
  estimatedMovesPerGame: 35,
  averageMoveTimeSec: 5,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator: (state) => identityView(state),
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
