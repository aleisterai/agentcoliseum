import { type GameAdapter, identityView } from "@/lib/game/types";
import {
  POINTS,
  game as backgammonGame,
  startingState,
  type BackgammonMove,
  type BackgammonState,
  type SubMove,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/** Opening position with a roll showing, for the catalog card. */
const previewState: BackgammonState = (() => {
  const s = startingState();
  s.rollPending = false;
  s.rolled = [3, 1];
  s.dice = [3, 1];
  return s;
})();

function asLoc(v: unknown, kind: "from" | "to"): number | "bar" | "off" | null {
  if (kind === "from" && v === "bar") return "bar";
  if (kind === "to" && v === "off") return "off";
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n < POINTS) return n;
  return null;
}

export const backgammonAdapter: GameAdapter<BackgammonState, BackgammonMove> = {
  id: "backgammon",
  displayName: "Backgammon",
  shortDescription: "Race home, hit, and bear off.",
  category: "dice",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: backgammonGame,
  previewState,
  // Aligned to the central clock policy (default 240s; per-move-sync.test.ts).
  clockBudgetMs: 240 * 1000,
  estimatedMovesPerGame: 60,
  averageMoveTimeSec: 3,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator: (state) => identityView(state),
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const p = payload as Record<string, unknown>;
    if (!Array.isArray(p.moves)) {
      return { ok: false, error: "moves must be an array (use [] to pass)" };
    }
    if (p.moves.length > 4) {
      return { ok: false, error: "at most 4 hops per turn" };
    }
    const moves: SubMove[] = [];
    for (const item of p.moves) {
      if (typeof item !== "object" || item === null) {
        return { ok: false, error: "each move must be { from, to }" };
      }
      const o = item as Record<string, unknown>;
      const from = asLoc(o.from, "from");
      const to = asLoc(o.to, "to");
      if (from === null) {
        return { ok: false, error: `move.from must be 0..${POINTS - 1} or "bar"` };
      }
      if (to === null) {
        return { ok: false, error: `move.to must be 0..${POINTS - 1} or "off"` };
      }
      moves.push({ from: from as number | "bar", to: to as number | "off" });
    }
    return { ok: true, move: { kind: "play", moves } };
  },
  toMoveAction: (move) => ({ moveName: "play", args: [{ moves: move.moves }] }),
};

export * from "./game";
