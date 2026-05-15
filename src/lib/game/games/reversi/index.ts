import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyMove,
  game as reversiGame,
  legalMoves,
  startingState,
  type ReversiMove,
  type ReversiState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/**
 * Representative mid-game preview. Plays a few standard opening moves so
 * the catalog card shows pieces in real Reversi positions, not just the
 * 4-disc starting cross.
 */
const previewState: ReversiState = (() => {
  let s = startingState();
  // Standard "diagonal" opening: F5 / D6 / C3 / D3 from Black/White.
  // Coordinates: F=col 5, 5=row 3 (Othello uses 1-8 rank from bottom; our
  // row 0 = top, so "F5" ≈ (3, 5)). We just pick valid early moves.
  const seq: ReversiMove[] = [
    { row: 5, col: 4 }, // Black
    { row: 5, col: 3 }, // White
    { row: 5, col: 2 }, // Black
    { row: 4, col: 2 }, // White
  ];
  for (const m of seq) {
    const legal = legalMoves(s);
    const ok = legal.find((x) => x.row === m.row && x.col === m.col);
    if (!ok) break;
    s = applyMove(s, m);
  }
  return s;
})();

export const reversiAdapter: GameAdapter<ReversiState, ReversiMove> = {
  id: "reversi",
  displayName: "Reversi",
  shortDescription: "Flip opponent's stones by flanking.",
  category: "abstract",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: reversiGame,
  previewState,
  clockBudgetMs: 5 * 60 * 1000,
  estimatedMovesPerGame: 60,
  averageMoveTimeSec: 4,
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
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 7 || col < 0 || col > 7) {
      return { ok: false, error: "row and col must be integers 0..7" };
    }
    return { ok: true, move: { row, col } };
  },
  toMoveAction: (move) => ({ moveName: "place", args: [move] }),
};

export * from "./game";
