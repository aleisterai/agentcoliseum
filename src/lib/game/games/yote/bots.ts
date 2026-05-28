/**
 * Yoté system bots.
 *
 *   easy   → random legal move.
 *   medium → greedy: grab a capture if one exists (prefer the wild double-
 *            remove), otherwise play a developing drop/move. Deterministic.
 *   hard   → 1-ply material search: score every legal move by the resulting
 *            piece differential minus the opponent's best immediate capture
 *            reply (so it grabs material without hanging pieces). Deterministic
 *            tie-break by move shape + lowest index.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  applyMove,
  legalMoves,
  opposite,
  totalPieces,
  type PlayerId,
  type YoteMove,
  type YoteState,
} from "./game";

function isCapture(m: YoteMove): boolean {
  return m.kind === "capture";
}

/** Pieces the side `victim` would lose to the opponent's single best reply. */
function opponentBestCaptureGain(s: YoteState): number {
  let worst = 0;
  for (const m of legalMoves(s)) {
    if (m.kind !== "capture") continue;
    // A capture removes the jumped piece (1) plus the wild bonus if present (1).
    const gain = m.remove != null ? 2 : 1;
    if (gain > worst) worst = gain;
  }
  return worst;
}

export const easyBot: BotStrategy<YoteState, YoteMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("easyBot: no moves");
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<YoteState, YoteMove> = {
  pickMove: (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("mediumBot: no moves");
    // Prefer captures, and among them the wild double-remove.
    const captures = moves.filter(isCapture);
    if (captures.length > 0) {
      const doubles = captures.filter((m) => m.kind === "capture" && m.remove != null);
      return (doubles.length > 0 ? doubles : captures)[0];
    }
    // No capture: prefer a non-capturing move (board development) over burning
    // reserve, falling back to a drop.
    const slides = moves.filter((m) => m.kind === "move");
    return (slides.length > 0 ? slides : moves)[0];
  },
};

export const hardBot: BotStrategy<YoteState, YoteMove> = {
  pickMove: (state, playerID) => {
    const me: PlayerId = playerID;
    const foe = opposite(me);
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("hardBot: no moves");

    let best = moves[0];
    let bestScore = -Infinity;
    for (const m of moves) {
      const after = applyMove(state, m);
      const material = totalPieces(after, me) - totalPieces(after, foe);
      // After my move it's the opponent's turn; how much can they take back?
      const exposure = opponentBestCaptureGain(after);
      // Capturing now is worth the material it nets; avoid hanging pieces.
      const score = material * 10 - exposure * 9 + (isCapture(m) ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  },
};
