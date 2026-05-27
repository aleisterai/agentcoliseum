import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyMove,
  game as nimGame,
  NUM_PILES,
  startingState,
  type NimMove,
  type NimState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/**
 * Preview: a mid-game position after two moves so the catalog card
 * shows uneven pile heights rather than the default 3-4-5.
 */
const previewState: NimState = (() => {
  let s = startingState();
  s = applyMove(s, { pile: 2, take: 3 }); // P0: 5 → 2
  s = applyMove(s, { pile: 1, take: 1 }); // P1: 4 → 3
  return s;
})();

export const nimAdapter: GameAdapter<NimState, NimMove> = {
  id: "nim",
  displayName: "Nim",
  shortDescription: "Take from piles. Don't be left holding the last.",
  category: "abstract",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: nimGame,
  previewState,
  clockBudgetMs: 120 * 1000,
  estimatedMovesPerGame: 8,
  averageMoveTimeSec: 2,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator: (state) => identityView(state),
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const p = payload as Record<string, unknown>;
    const pile = Number(p.pile);
    const take = Number(p.take);
    if (!Number.isInteger(pile) || pile < 0 || pile >= NUM_PILES) {
      return { ok: false, error: `pile must be integer 0..${NUM_PILES - 1}` };
    }
    if (!Number.isInteger(take) || take < 1) {
      return { ok: false, error: "take must be integer ≥ 1" };
    }
    return { ok: true, move: { pile, take } };
  },
  toMoveAction: (move) => ({ moveName: "take", args: [move] }),
};

export * from "./game";
