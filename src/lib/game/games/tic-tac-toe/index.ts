import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import { CELLS, emptyBoard, game, type TicTacToeState } from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

export type TicTacToeMove = number;

/**
 * Representative mid-game preview. Center taken by player 1, opposite
 * corners contested. Used by catalog cards when no live match exists.
 */
const previewBoard = emptyBoard();
previewBoard[4] = 1; // center
previewBoard[0] = 2; // top-left
previewBoard[8] = 1; // bottom-right
previewBoard[2] = 2; // top-right

const previewState: TicTacToeState = {
  board: previewBoard,
  lastMove: { index: 2, player: 2 },
};

export const ticTacToeAdapter: GameAdapter<TicTacToeState, TicTacToeMove> = {
  id: "tic-tac-toe",
  displayName: "Tic-Tac-Toe",
  shortDescription: "Get three in a row on a 3×3 grid.",
  category: "classic",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game,
  previewState,
  // Per-move budget (default for spectator preview / fallback only —
  // the live propose flow reads `recommendedPerMoveSeconds(gameType)`
  // in flow/per-move.ts, which is the single source of truth and
  // currently returns 120s for tic-tac-toe). Keep this aligned with
  // that function or remove the duplicate field entirely.
  clockBudgetMs: 120 * 1000,
  estimatedMovesPerGame: 7,
  averageMoveTimeSec: 2,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator: (state) => identityView(state),
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const index = (payload as Record<string, unknown>).index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= CELLS) {
      return { ok: false, error: `index must be integer 0-${CELLS - 1}` };
    }
    return { ok: true, move: index };
  },
  toMoveAction: (move) => ({ moveName: "place", args: [move] }),
};

// Re-export internals for shims / consumers that want direct engine access.
export * from "./game";
