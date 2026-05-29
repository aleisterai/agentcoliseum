import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyTurn,
  game as fanoronaGame,
  N,
  startingState,
  type CaptureKind,
  type FanoronaMove,
  type FanoronaState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/**
 * Preview: the classic Fanorona opening — player 0 advances the centre-file
 * piece into the empty centre and captures the two enemy pieces above it by
 * approach. Shows movement + a capture so the catalogue card isn't a static
 * full board.
 */
const previewState: FanoronaState = (() => {
  const start = startingState();
  // (3,4)=31 → (2,4)=22 (centre), approaching north over (1,4)=13 and (0,4)=4.
  const res = applyTurn(start, "0", {
    from: 31,
    steps: [{ to: 22, capture: "approach" }],
  });
  return res.ok ? res.next : start;
})();

function asInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export const fanoronaAdapter: GameAdapter<FanoronaState, FanoronaMove> = {
  id: "fanorona",
  displayName: "Fanorona",
  shortDescription: "Madagascar capture game — approach & withdraw, forced takes.",
  category: "classic",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: fanoronaGame,
  previewState,
  // Default per-move budget for this class (per-move-sync.test.ts enforces
  // this equals recommendedPerMoveSeconds("fanorona") * 1000).
  clockBudgetMs: 240 * 1000,
  estimatedMovesPerGame: 60,
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
    if (from === null || from < 0 || from >= N) {
      return { ok: false, error: `from must be an integer 0..${N - 1}` };
    }
    if (!Array.isArray(p.steps) || p.steps.length === 0) {
      return { ok: false, error: "steps must be a non-empty array" };
    }
    const steps: FanoronaMove["steps"] = [];
    for (let i = 0; i < p.steps.length; i++) {
      const raw = p.steps[i];
      if (typeof raw !== "object" || raw === null) {
        return { ok: false, error: `steps[${i}] must be an object` };
      }
      const st = raw as Record<string, unknown>;
      const to = asInt(st.to);
      if (to === null || to < 0 || to >= N) {
        return { ok: false, error: `steps[${i}].to must be an integer 0..${N - 1}` };
      }
      let capture: CaptureKind | null;
      if (st.capture == null) {
        capture = null;
      } else if (st.capture === "approach" || st.capture === "withdraw") {
        capture = st.capture;
      } else {
        return {
          ok: false,
          error: `steps[${i}].capture must be "approach", "withdraw", or null`,
        };
      }
      steps.push({ to, capture });
    }
    return { ok: true, move: { from, steps } };
  },
  toMoveAction: (move) => ({ moveName: "play", args: [move] }),
};

export * from "./game";
