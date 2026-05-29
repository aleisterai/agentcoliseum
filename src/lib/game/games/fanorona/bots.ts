/**
 * Fanorona system bots.
 *
 *   easy   → random legal turn.
 *   medium → greedy: among legal turns, take the one that captures the most
 *            pieces this turn (forced-capture rule guarantees a capture when
 *            one exists). Random tie-break, so easy/medium add variety.
 *   hard   → 1-ply material search: score every legal turn by pieces captured
 *            this turn + resulting material differential − the opponent's best
 *            immediate capture reply, with a small strong-point/centre bonus.
 *            Deterministic tie-break (serialized move) so replays reproduce.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  applyTurn,
  isStrong,
  legalTurns,
  opposite,
  pieceCount,
  type FanoronaMove,
  type FanoronaState,
  type PlayerId,
} from "./game";

function capturedThisTurn(s: FanoronaState, player: PlayerId, m: FanoronaMove): number {
  const res = applyTurn(s, player, m);
  if (!res.ok) return -1;
  return res.next.lastMove?.captured ?? 0;
}

/** Most pieces the opponent could capture in a single reply from `s`. */
function opponentBestCapture(s: FanoronaState): number {
  const foe = s.turn;
  let worst = 0;
  for (const m of legalTurns(s, foe)) {
    const res = applyTurn(s, foe, m);
    if (!res.ok) continue;
    const got = res.next.lastMove?.captured ?? 0;
    if (got > worst) worst = got;
  }
  return worst;
}

/** Small positional bonus: how many of my pieces sit on strong (8-way) points. */
function strongControl(s: FanoronaState, me: PlayerId): number {
  let n = 0;
  for (let i = 0; i < s.board.length; i++) {
    if (s.board[i] === me && isStrong(i)) n++;
  }
  return n;
}

export const easyBot: BotStrategy<FanoronaState, FanoronaMove> = {
  pickMove: (state, playerID) => {
    const moves = legalTurns(state, playerID);
    if (moves.length === 0) throw new Error("easyBot: no legal turn");
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<FanoronaState, FanoronaMove> = {
  pickMove: (state, playerID) => {
    const moves = legalTurns(state, playerID);
    if (moves.length === 0) throw new Error("mediumBot: no legal turn");
    let best = -1;
    const top: FanoronaMove[] = [];
    for (const m of moves) {
      const got = capturedThisTurn(state, playerID, m);
      if (got > best) {
        best = got;
        top.length = 0;
        top.push(m);
      } else if (got === best) {
        top.push(m);
      }
    }
    return top[Math.floor(Math.random() * top.length)];
  },
};

export const hardBot: BotStrategy<FanoronaState, FanoronaMove> = {
  pickMove: (state, playerID) => {
    const me: PlayerId = playerID;
    const foe = opposite(me);
    const moves = legalTurns(state, me);
    if (moves.length === 0) throw new Error("hardBot: no legal turn");

    let best = moves[0];
    let bestScore = -Infinity;
    let bestKey = "";
    for (const m of moves) {
      const res = applyTurn(state, me, m);
      if (!res.ok) continue;
      const after = res.next;
      const captured = after.lastMove?.captured ?? 0;
      const material = pieceCount(after, me) - pieceCount(after, foe);
      const exposure = opponentBestCapture(after); // opponent is to move in `after`
      const control = strongControl(after, me);
      const score = captured * 12 + material * 10 - exposure * 9 + control;
      const key = JSON.stringify(m);
      // Deterministic: higher score wins; tie-break by lexicographically
      // smallest serialized move.
      if (score > bestScore || (score === bestScore && key < bestKey)) {
        bestScore = score;
        best = m;
        bestKey = key;
      }
    }
    return best;
  },
};
