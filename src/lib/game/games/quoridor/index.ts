import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  SIZE,
  WALL_SLOTS,
  applyMove,
  game as quoridorGame,
  legalMoves,
  startingState,
  type QuoridorMove,
  type QuoridorState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/** Decorative preview — both pawns step forward a few times. */
const previewState: QuoridorState = (() => {
  let s = startingState();
  const seq: QuoridorMove[] = [
    { kind: "pawn", to: { row: 1, col: 4 } }, // P0
    { kind: "pawn", to: { row: 7, col: 4 } }, // P1
    { kind: "wall", wall: { type: "h", row: 1, col: 3 } }, // P0 walls
    { kind: "pawn", to: { row: 6, col: 4 } }, // P1
  ];
  for (const m of seq) {
    if (legalMoves(s).some((x) => JSON.stringify(x) === JSON.stringify(m))) {
      s = applyMove(s, m);
    }
  }
  return s;
})();

export const quoridorAdapter: GameAdapter<QuoridorState, QuoridorMove> = {
  id: "quoridor",
  displayName: "Quoridor",
  shortDescription: "Race to the far row — or build walls to slow your rival.",
  category: "abstract",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: quoridorGame,
  previewState,
  clockBudgetMs: 5 * 60 * 1000,
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
    if (p.kind !== "pawn" && p.kind !== "wall") {
      return { ok: false, error: "kind must be 'pawn' or 'wall'" };
    }
    if (p.kind === "pawn") {
      const t = p.to as { row?: unknown; col?: unknown } | undefined;
      if (!t) return { ok: false, error: "pawn move requires `to`" };
      const row = Number(t.row);
      const col = Number(t.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= SIZE || col < 0 || col >= SIZE) {
        return { ok: false, error: `to.row and to.col must be integers 0..${SIZE - 1}` };
      }
      return { ok: true, move: { kind: "pawn", to: { row, col } } };
    }
    const w = p.wall as { type?: unknown; row?: unknown; col?: unknown } | undefined;
    if (!w) return { ok: false, error: "wall move requires `wall`" };
    if (w.type !== "h" && w.type !== "v") return { ok: false, error: "wall.type must be 'h' or 'v'" };
    const row = Number(w.row);
    const col = Number(w.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= WALL_SLOTS || col < 0 || col >= WALL_SLOTS) {
      return { ok: false, error: `wall.row and wall.col must be integers 0..${WALL_SLOTS - 1}` };
    }
    return { ok: true, move: { kind: "wall", wall: { type: w.type, row, col } } };
  },
  toMoveAction: (move) => ({ moveName: "play", args: [move] }),
};

export * from "./game";
