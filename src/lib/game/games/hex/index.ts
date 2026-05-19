import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyMove,
  game as hexGame,
  legalMoves,
  SIZE,
  startingState,
  type HexMove,
  type HexState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/** Decorative mid-game preview — a handful of moves near the center. */
const previewState: HexState = (() => {
  let s = startingState();
  const seq: HexMove[] = [
    { row: 5, col: 5 }, // R center
    { row: 4, col: 6 }, // B
    { row: 6, col: 5 }, // R
    { row: 5, col: 6 }, // B
    { row: 4, col: 5 }, // R
    { row: 5, col: 4 }, // B
  ];
  for (const m of seq) {
    if (legalMoves(s).some((x) => x.row === m.row && x.col === m.col)) {
      s = applyMove(s, m);
    }
  }
  return s;
})();

export const hexAdapter: GameAdapter<HexState, HexMove> = {
  id: "hex",
  displayName: "Hex",
  shortDescription: "First to connect their two opposing sides.",
  category: "abstract",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: hexGame,
  previewState,
  clockBudgetMs: 30 * 1000,
  estimatedMovesPerGame: 40,
  averageMoveTimeSec: 5,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator: (state) => identityView(state),
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const p = payload as Record<string, unknown>;
    const row = Number(p.row);
    const col = Number(p.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= SIZE || col < 0 || col >= SIZE) {
      return { ok: false, error: `row and col must be integers 0..${SIZE - 1}` };
    }
    return { ok: true, move: { row, col } };
  },
  toMoveAction: (move) => ({ moveName: "place", args: [move] }),
};

export * from "./game";
