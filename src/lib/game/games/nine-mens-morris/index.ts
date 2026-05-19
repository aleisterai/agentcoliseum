import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  NUM_POINTS,
  applyMove,
  game as nmmGame,
  legalMoves,
  startingState,
  type NMMMove,
  type NMMState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/**
 * Decorative preview — a few opening placements showing tension at the
 * center of the board (the strongest squares).
 */
const previewState: NMMState = (() => {
  let s = startingState();
  const seq: NMMMove[] = [
    { from: null, to: 4 },   // P0
    { from: null, to: 10 },  // P1
    { from: null, to: 13 },  // P0
    { from: null, to: 16 },  // P1
    { from: null, to: 19 },  // P0
    { from: null, to: 1 },   // P1
  ];
  for (const m of seq) {
    const candidates = legalMoves(s);
    const ok = candidates.find((x) => x.from === m.from && x.to === m.to && x.remove === undefined);
    if (!ok) break;
    s = applyMove(s, ok);
  }
  return s;
})();

export const nineMensMorrisAdapter: GameAdapter<NMMState, NMMMove> = {
  id: "nine-mens-morris",
  displayName: "Nine Men's Morris",
  shortDescription: "Form mills to remove opposing pieces.",
  category: "classic",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: nmmGame,
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
    let from: number | null;
    if (p.from === null) {
      from = null;
    } else if (Number.isInteger(p.from)) {
      from = p.from as number;
      if (from < 0 || from >= NUM_POINTS) return { ok: false, error: `from must be 0..${NUM_POINTS - 1} or null` };
    } else {
      return { ok: false, error: "from must be null or integer 0..23" };
    }
    const to = Number(p.to);
    if (!Number.isInteger(to) || to < 0 || to >= NUM_POINTS) {
      return { ok: false, error: `to must be integer 0..${NUM_POINTS - 1}` };
    }
    const move: NMMMove = { from, to };
    if (p.remove !== undefined) {
      const rem = Number(p.remove);
      if (!Number.isInteger(rem) || rem < 0 || rem >= NUM_POINTS) {
        return { ok: false, error: `remove must be integer 0..${NUM_POINTS - 1}` };
      }
      move.remove = rem;
    }
    return { ok: true, move };
  },
  toMoveAction: (move) => ({ moveName: "play", args: [move] }),
};

export * from "./game";
