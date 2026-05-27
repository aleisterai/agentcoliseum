import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyMove,
  game as mancalaGame,
  legalMoves,
  startingState,
  TOTAL_PITS,
  type MancalaMove,
  type MancalaState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/**
 * Mid-game preview: a handful of moves into a starting game, with
 * stones moved around so the catalog card shows real distribution
 * rather than the symmetric 4-4-4-4-4-4 start.
 */
const previewState: MancalaState = (() => {
  let s = startingState();
  const seq: MancalaMove[] = [
    { pit: 2 }, // P0 sows from pit 2 (4 seeds → 3,4,5,6 — lands in store, bonus turn)
    { pit: 1 }, // P0 again, sows from pit 1
    { pit: 9 }, // P1 sows from pit 9
  ];
  for (const m of seq) {
    if (legalMoves(s).some((x) => x.pit === m.pit)) {
      s = applyMove(s, m);
    }
  }
  return s;
})();

export const mancalaAdapter: GameAdapter<MancalaState, MancalaMove> = {
  id: "mancala",
  displayName: "Mancala",
  shortDescription: "Sow seeds, capture, and out-store your opponent.",
  category: "abstract",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: mancalaGame,
  previewState,
  clockBudgetMs: 240 * 1000,
  estimatedMovesPerGame: 25,
  averageMoveTimeSec: 3,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator: (state) => identityView(state),
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const pit = Number((payload as Record<string, unknown>).pit);
    if (!Number.isInteger(pit) || pit < 0 || pit >= TOTAL_PITS) {
      return { ok: false, error: `pit must be integer 0..${TOTAL_PITS - 1}` };
    }
    return { ok: true, move: { pit } };
  },
  toMoveAction: (move) => ({ moveName: "sow", args: [move] }),
};

export * from "./game";
