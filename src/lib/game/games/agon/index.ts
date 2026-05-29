import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyMove,
  game as agonGame,
  N,
  startingState,
  type AgonMove,
  type AgonState,
  type PlayerId,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/** Preview: a few deterministic opening moves so the catalogue card shows
 *  pieces advancing off the rim rather than the static start. */
const previewState: AgonState = (() => {
  let s = startingState();
  for (let i = 0; i < 8; i++) {
    const mover: PlayerId = s.turn;
    const move = hardBot.pickMove(s, mover) as AgonMove;
    s = applyMove(s, mover, move);
  }
  return s;
})();

function asInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export const agonAdapter: GameAdapter<AgonState, AgonMove> = {
  id: "agon",
  displayName: "Agon",
  shortDescription: "Queen's Guard — race the queen to the centre on a hex board.",
  category: "abstract",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: agonGame,
  previewState,
  // Default per-move budget for this class (per-move-sync.test.ts enforces
  // this equals recommendedPerMoveSeconds("agon") * 1000).
  clockBudgetMs: 240 * 1000,
  estimatedMovesPerGame: 70,
  averageMoveTimeSec: 4,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator: (state) => identityView(state),
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const p = payload as Record<string, unknown>;
    const from = asInt(p.from);
    const to = asInt(p.to);
    if (from === null || from < 0 || from >= N) {
      return { ok: false, error: `from must be an integer 0..${N - 1}` };
    }
    if (to === null || to < 0 || to >= N) {
      return { ok: false, error: `to must be an integer 0..${N - 1}` };
    }
    return { ok: true, move: { from, to } };
  },
  toMoveAction: (move) => ({ moveName: "play", args: [move] }),
};

export * from "./game";
