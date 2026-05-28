import type { GameAdapter, SpectatorView } from "@/lib/game/types";
import {
  FACES,
  game as liarsDiceGame,
  type LiarsDiceMove,
  type LiarsDiceState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/** A representative mid-round position for the catalog card. */
const previewState: LiarsDiceState = {
  dice: { "0": [3, 3, 5, 1, 6], "1": [2, 4, 4, 6, 1] },
  diceCount: { "0": 5, "1": 5 },
  bid: { quantity: 4, face: 4 },
  bidder: "0",
  turn: "1",
  round: 1,
  rerollPending: false,
  lastChallenge: null,
  lastMove: { kind: "bid", quantity: 4, face: 4 },
};

/**
 * Imperfect-information serializer — the security gate. Spectators and the
 * opposing player must never see a live cup. We blank both cups in the
 * public state (the public dice COUNTS live in `diceCount`, which stays
 * visible), keep the standing bid + the last challenge's reveal public, and
 * attach only the requesting player's own cup as `privateAddendum`.
 */
function serializeForSpectator(
  state: LiarsDiceState,
  viewer: "0" | "1" | "spectator",
  gameOver: boolean,
): SpectatorView {
  // At game over the final cups are fully revealed.
  if (gameOver) return { publicState: state };
  const publicState: LiarsDiceState = {
    ...state,
    dice: { "0": [], "1": [] }, // hidden; counts are in diceCount
  };
  if (viewer === "0" || viewer === "1") {
    return { publicState, privateAddendum: { myDice: state.dice[viewer] } };
  }
  return { publicState };
}

function asInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export const liarsDiceAdapter: GameAdapter<LiarsDiceState, LiarsDiceMove> = {
  id: "liars-dice",
  displayName: "Liar's Dice",
  shortDescription: "Bid higher, or call the bluff.",
  category: "imperfect-info",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: liarsDiceGame,
  previewState,
  // Aligned to the central clock policy in recommendedPerMoveSeconds()
  // (enforced by per-move-sync.test.ts).
  clockBudgetMs: 240 * 1000,
  estimatedMovesPerGame: 24,
  averageMoveTimeSec: 2,
  perfectInformation: false,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator,
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const p = payload as Record<string, unknown>;
    if (p.kind === "challenge") {
      return { ok: true, move: { kind: "challenge" } };
    }
    if (p.kind === "bid") {
      const quantity = asInt(p.quantity);
      const face = asInt(p.face);
      if (quantity === null || quantity < 1) {
        return { ok: false, error: "bid.quantity must be an integer ≥ 1" };
      }
      if (face === null || face < 1 || face > FACES) {
        return { ok: false, error: `bid.face must be an integer 1..${FACES}` };
      }
      return { ok: true, move: { kind: "bid", quantity, face } };
    }
    return { ok: false, error: "kind must be 'bid' | 'challenge'" };
  },
  toMoveAction: (move) =>
    move.kind === "bid"
      ? { moveName: "bid", args: [{ quantity: move.quantity, face: move.face }] }
      : { moveName: "challenge", args: [] },
};

export * from "./game";
