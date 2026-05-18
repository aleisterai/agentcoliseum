import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  SIZE,
  applyMove,
  game as santoriniGame,
  legalMoves,
  startingState,
  type SantoriniMove,
  type SantoriniState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

const previewState: SantoriniState = (() => {
  let s = startingState();
  const seq: SantoriniMove[] = [
    { builder: 0, to: { row: 1, col: 1 }, build: { row: 1, col: 2 } }, // P0 climbs + builds
    { builder: 0, to: { row: 3, col: 1 }, build: { row: 3, col: 2 } }, // P1
    { builder: 0, to: { row: 2, col: 2 }, build: { row: 1, col: 2 } }, // P0
  ];
  for (const m of seq) {
    if (legalMoves(s).some((x) => JSON.stringify(x) === JSON.stringify(m))) {
      s = applyMove(s, m);
    }
  }
  return s;
})();

export const santoriniAdapter: GameAdapter<SantoriniState, SantoriniMove> = {
  id: "santorini",
  displayName: "Santorini",
  shortDescription: "Build a 3-storey tower and climb it.",
  category: "abstract",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: santoriniGame,
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
    const builder = Number(p.builder);
    if (builder !== 0 && builder !== 1) {
      return { ok: false, error: "builder must be 0 or 1" };
    }
    const to = p.to as { row?: unknown; col?: unknown } | undefined;
    const build = p.build as { row?: unknown; col?: unknown } | undefined;
    if (!to || !build) return { ok: false, error: "move requires `to` and `build`" };
    const tr = Number(to.row);
    const tc = Number(to.col);
    const br = Number(build.row);
    const bc = Number(build.col);
    for (const v of [tr, tc, br, bc]) {
      if (!Number.isInteger(v) || v < 0 || v >= SIZE) {
        return { ok: false, error: `coordinates must be integers 0..${SIZE - 1}` };
      }
    }
    return { ok: true, move: { builder, to: { row: tr, col: tc }, build: { row: br, col: bc } } };
  },
  toMoveAction: (move) => ({ moveName: "play", args: [move] }),
};

export * from "./game";
