import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  SIZE,
  applyMove,
  game as takGame,
  legalMoves,
  startingState,
  type TakMove,
  type TakState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/**
 * Decorative preview — a handful of flat placements showing two emerging
 * roads in different orientations.
 */
const previewState: TakState = (() => {
  let s = startingState();
  const seq: TakMove[] = [
    { to: { row: 2, col: 2 }, kind: "F" }, // P0 center
    { to: { row: 0, col: 0 }, kind: "F" }, // P1 corner
    { to: { row: 2, col: 1 }, kind: "F" }, // P0
    { to: { row: 1, col: 0 }, kind: "F" }, // P1
    { to: { row: 2, col: 3 }, kind: "F" }, // P0
    { to: { row: 2, col: 0 }, kind: "W" }, // P1 wall to block
  ];
  for (const m of seq) {
    if (legalMoves(s).some((x) => x.to.row === m.to.row && x.to.col === m.to.col && x.kind === m.kind)) {
      s = applyMove(s, m);
    }
  }
  return s;
})();

export const takAdapter: GameAdapter<TakState, TakMove> = {
  id: "tak",
  displayName: "Tak",
  shortDescription: "Build a road of your color from edge to edge.",
  category: "abstract",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: takGame,
  previewState,
  clockBudgetMs: 600 * 1000,
  estimatedMovesPerGame: 30,
  averageMoveTimeSec: 6,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator: (state) => identityView(state),
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const p = payload as Record<string, unknown>;
    const to = p.to as { row?: unknown; col?: unknown } | undefined;
    if (!to) return { ok: false, error: "move requires `to`" };
    const row = Number(to.row);
    const col = Number(to.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= SIZE || col < 0 || col >= SIZE) {
      return { ok: false, error: `to.row and to.col must be integers 0..${SIZE - 1}` };
    }
    if (p.kind !== "F" && p.kind !== "W") return { ok: false, error: "kind must be 'F' or 'W'" };
    return { ok: true, move: { to: { row, col }, kind: p.kind } };
  },
  toMoveAction: (move) => ({ moveName: "place", args: [move] }),
};

export * from "./game";
