import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyMove,
  game as checkersGame,
  legalMoves,
  startingState,
  type CheckersMove,
  type CheckersState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/**
 * Mid-game preview after the standard 11-15 / 22-18 / 15x22 / 25x18 sequence.
 * Both sides have made early trades; men still on home ranks. Used on
 * catalog cards / spotlight when no live match exists.
 */
const previewState: CheckersState = (() => {
  let s = startingState();
  const seq: CheckersMove[] = [
    { from: [5, 2], path: [[4, 3]] }, // White 11-15 equivalent
    { from: [2, 3], path: [[3, 2]] }, // Black 22-18 equivalent
  ];
  for (const m of seq) {
    const legal = legalMoves(s);
    const match = legal.find(
      (x) =>
        x.from[0] === m.from[0] &&
        x.from[1] === m.from[1] &&
        x.path.length === m.path.length &&
        x.path.every((p, i) => p[0] === m.path[i][0] && p[1] === m.path[i][1]),
    );
    if (!match) break; // preview is decorative; bail if the seed becomes illegal
    s = applyMove(s, match);
  }
  return s;
})();

export const checkersAdapter: GameAdapter<CheckersState, CheckersMove> = {
  id: "checkers",
  displayName: "Checkers",
  shortDescription: "English draughts. Mandatory jumps, king the back rank.",
  category: "classic",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: checkersGame,
  previewState,
  clockBudgetMs: 5 * 60 * 1000,
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
    if (!Array.isArray(p.from) || p.from.length !== 2) {
      return { ok: false, error: "from must be [row, col]" };
    }
    if (!Array.isArray(p.path) || p.path.length === 0) {
      return { ok: false, error: "path must be a non-empty array of [row, col]" };
    }
    const fromR = Number(p.from[0]);
    const fromC = Number(p.from[1]);
    if (!Number.isInteger(fromR) || !Number.isInteger(fromC) || fromR < 0 || fromR > 7 || fromC < 0 || fromC > 7) {
      return { ok: false, error: "from coordinates must be integers 0..7" };
    }
    const path: Array<[number, number]> = [];
    for (const step of p.path as unknown[]) {
      if (!Array.isArray(step) || step.length !== 2) {
        return { ok: false, error: "every path entry must be [row, col]" };
      }
      const r = Number(step[0]);
      const c = Number(step[1]);
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r > 7 || c < 0 || c > 7) {
        return { ok: false, error: "path coordinates must be integers 0..7" };
      }
      path.push([r, c]);
    }
    return { ok: true, move: { from: [fromR, fromC], path } };
  },
  toMoveAction: (move) => ({ moveName: "play", args: [move] }),
};

export * from "./game";
