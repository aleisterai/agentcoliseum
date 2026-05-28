import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyMove,
  game as yoteGame,
  N,
  startingState,
  type YoteMove,
  type YoteState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/** Preview: a few pieces dropped by both sides so the catalog card shows a
 *  populated board rather than 30 empty cells. */
const previewState: YoteState = (() => {
  let s = startingState();
  s = applyMove(s, { kind: "drop", to: 14 }); // P0
  s = applyMove(s, { kind: "drop", to: 15 }); // P1
  s = applyMove(s, { kind: "drop", to: 8 }); // P0
  s = applyMove(s, { kind: "drop", to: 21 }); // P1
  s = applyMove(s, { kind: "drop", to: 9 }); // P0
  s = applyMove(s, { kind: "drop", to: 20 }); // P1
  return s;
})();

function asInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export const yoteAdapter: GameAdapter<YoteState, YoteMove> = {
  id: "yote",
  displayName: "Yoté",
  shortDescription: "West African capture game with a wild remove.",
  category: "classic",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: yoteGame,
  previewState,
  // Must match the central clock policy in recommendedPerMoveSeconds()
  // (enforced by per-move-sync.test.ts) — 240s per move for this class.
  clockBudgetMs: 240 * 1000,
  estimatedMovesPerGame: 40,
  averageMoveTimeSec: 3,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator: (state) => identityView(state),
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const p = payload as Record<string, unknown>;
    const kind = p.kind;
    if (kind === "drop") {
      const to = asInt(p.to);
      if (to === null || to < 0 || to >= N) {
        return { ok: false, error: `drop.to must be integer 0..${N - 1}` };
      }
      return { ok: true, move: { kind: "drop", to } };
    }
    if (kind === "move") {
      const from = asInt(p.from);
      const to = asInt(p.to);
      if (from === null || from < 0 || from >= N) {
        return { ok: false, error: `move.from must be integer 0..${N - 1}` };
      }
      if (to === null || to < 0 || to >= N) {
        return { ok: false, error: `move.to must be integer 0..${N - 1}` };
      }
      return { ok: true, move: { kind: "move", from, to } };
    }
    if (kind === "capture") {
      const from = asInt(p.from);
      const to = asInt(p.to);
      if (from === null || from < 0 || from >= N) {
        return { ok: false, error: `capture.from must be integer 0..${N - 1}` };
      }
      if (to === null || to < 0 || to >= N) {
        return { ok: false, error: `capture.to must be integer 0..${N - 1}` };
      }
      let remove: number | null = null;
      if (p.remove != null) {
        const r = asInt(p.remove);
        if (r === null || r < 0 || r >= N) {
          return { ok: false, error: `capture.remove must be integer 0..${N - 1} or null` };
        }
        remove = r;
      }
      return { ok: true, move: { kind: "capture", from, to, remove } };
    }
    return { ok: false, error: "kind must be 'drop' | 'move' | 'capture'" };
  },
  toMoveAction: (move) => ({ moveName: "play", args: [move] }),
};

export * from "./game";
