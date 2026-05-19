import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyMove,
  game as gomokuGame,
  indexOf,
  legalMoves,
  startingState,
  type GomokuMove,
  type GomokuState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/**
 * Mid-game preview: a few stones around the center showing two competing
 * lines. Decorative — gets shown on the catalog card.
 */
const previewState: GomokuState = (() => {
  let s = startingState();
  const seq: GomokuMove[] = [
    { row: 7, col: 7 }, // B center
    { row: 8, col: 7 }, // W
    { row: 7, col: 8 }, // B
    { row: 6, col: 8 }, // W
    { row: 7, col: 6 }, // B (three in a row on row 7)
    { row: 7, col: 9 }, // W (blocks)
  ];
  for (const m of seq) {
    const legal = legalMoves(s);
    const ok = legal.find((x) => x.row === m.row && x.col === m.col);
    if (!ok) break;
    s = applyMove(s, m);
  }
  return s;
})();

export const gomokuAdapter: GameAdapter<GomokuState, GomokuMove> = {
  id: "gomoku",
  displayName: "Gomoku",
  shortDescription: "Five in a row on a 15×15 board.",
  category: "classic",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: gomokuGame,
  previewState,
  clockBudgetMs: 30 * 1000,
  estimatedMovesPerGame: 50,
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
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 14 || col < 0 || col > 14) {
      return { ok: false, error: "row and col must be integers 0..14" };
    }
    return { ok: true, move: { row, col } };
  },
  toMoveAction: (move) => ({ moveName: "place", args: [move] }),
};

// Suppress unused-import warning while we hold this for future use.
void indexOf;
export * from "./game";
