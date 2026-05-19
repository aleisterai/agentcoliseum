import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyMove,
  game as dabGame,
  legalMoves,
  startingState,
  HE_ROWS,
  HE_COLS,
  VE_ROWS,
  VE_COLS,
  type DotsBoxesMove,
  type DotsBoxesState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/** Decorative mid-game preview — a few edges drawn, one box claimed. */
const previewState: DotsBoxesState = (() => {
  let s = startingState();
  const seq: DotsBoxesMove[] = [
    { type: "h", row: 1, col: 1 }, // top of box (1,1)
    { type: "v", row: 1, col: 1 }, // left of box (1,1)
    { type: "h", row: 2, col: 1 }, // bottom of box (1,1) — third side
    { type: "v", row: 1, col: 2 }, // right of box (1,1) — completes box for whoever moves now
  ];
  for (const m of seq) {
    if (legalMoves(s).some((x) => x.type === m.type && x.row === m.row && x.col === m.col)) {
      s = applyMove(s, m);
    }
  }
  return s;
})();

export const dotsAndBoxesAdapter: GameAdapter<DotsBoxesState, DotsBoxesMove> = {
  id: "dots-and-boxes",
  displayName: "Dots & Boxes",
  shortDescription: "Claim the last edge to close a box.",
  category: "abstract",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: dabGame,
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
    if (p.type !== "h" && p.type !== "v") return { ok: false, error: "type must be 'h' or 'v'" };
    const row = Number(p.row);
    const col = Number(p.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      return { ok: false, error: "row and col must be integers" };
    }
    if (p.type === "h" && (row < 0 || row >= HE_ROWS || col < 0 || col >= HE_COLS)) {
      return { ok: false, error: `horizontal row must be 0..${HE_ROWS - 1}, col 0..${HE_COLS - 1}` };
    }
    if (p.type === "v" && (row < 0 || row >= VE_ROWS || col < 0 || col >= VE_COLS)) {
      return { ok: false, error: `vertical row must be 0..${VE_ROWS - 1}, col 0..${VE_COLS - 1}` };
    }
    return { ok: true, move: { type: p.type, row, col } };
  },
  toMoveAction: (move) => ({ moveName: "draw", args: [move] }),
};

export * from "./game";
