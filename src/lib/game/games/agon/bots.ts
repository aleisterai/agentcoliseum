/**
 * Agon system bots.
 *
 *   easy   → random legal move.
 *   medium → greedy: maximise a static center-race + flank-threat eval of the
 *            position after the move. Random tie-break.
 *   hard   → 2-ply negamax over the same eval (your move + the opponent's best
 *            reply), so it pushes toward the centre, rings the queen, grabs an
 *            enemy-queen flank, and avoids hanging its own queen. Deterministic
 *            tie-break (serialized move) for replayable self-play.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  CENTER,
  NEIGHBORS,
  RING,
  RING1,
  RINGS,
  applyMove,
  checkResult,
  legalMoves,
  opposite,
  ownerOf,
  queenCell,
  type AgonMove,
  type AgonState,
  type PlayerId,
} from "./game";

const INF = 1e7;

/** Bonus for `attacker` threatening `defender`'s queen with a one-move flank. */
function flankThreat(s: AgonState, attacker: PlayerId, defender: PlayerId): number {
  const oq = queenCell(s, defender);
  if (oq < 0) return 0;
  let bonus = 0;
  for (let d = 0; d < 6; d++) {
    const near = NEIGHBORS[oq][d];
    const opp = NEIGHBORS[oq][(d + 3) % 6];
    if (near < 0 || opp < 0) continue;
    if (ownerOf(s.board[near]) === attacker && s.board[opp] === "") bonus += 30;
  }
  return bonus;
}

function centerScore(s: AgonState, p: PlayerId): number {
  const q = queenCell(s, p);
  if (q < 0) return -100000;
  let score = (RINGS - 1 - RING[q]) * 50;
  if (q === CENTER) score += 200;
  const guard = (p + "G") as AgonState["board"][number];
  for (let i = 0; i < s.board.length; i++) {
    if (s.board[i] !== guard) continue;
    score += (RINGS - 1 - RING[i]) * 2;
    if (RING1.includes(i)) score += 12;
  }
  return score;
}

/** Static eval of `state` from `player`'s point of view. */
function evalFrom(state: AgonState, player: PlayerId): number {
  const foe = opposite(player);
  return (
    centerScore(state, player) -
    centerScore(state, foe) +
    flankThreat(state, player, foe) -
    flankThreat(state, foe, player)
  );
}

function negamax(state: AgonState, player: PlayerId, depth: number): number {
  const res = checkResult(state);
  if (res.status === "win") return res.winner === player ? INF : -INF;
  if (res.status === "draw") return 0;
  if (depth <= 0) return evalFrom(state, player);
  let best = -Infinity;
  for (const m of legalMoves(state, player)) {
    const v = -negamax(applyMove(state, player, m), opposite(player), depth - 1);
    if (v > best) best = v;
  }
  return best;
}

export const easyBot: BotStrategy<AgonState, AgonMove> = {
  pickMove: (state, playerID) => {
    const moves = legalMoves(state, playerID);
    if (moves.length === 0) throw new Error("easyBot: no legal move");
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<AgonState, AgonMove> = {
  pickMove: (state, playerID) => {
    const me: PlayerId = playerID;
    const moves = legalMoves(state, me);
    if (moves.length === 0) throw new Error("mediumBot: no legal move");
    let best = -Infinity;
    const top: AgonMove[] = [];
    for (const m of moves) {
      const after = applyMove(state, me, m);
      const res = checkResult(after);
      const v =
        res.status === "win"
          ? res.winner === me
            ? INF
            : -INF
          : evalFrom(after, me);
      if (v > best) {
        best = v;
        top.length = 0;
        top.push(m);
      } else if (v === best) {
        top.push(m);
      }
    }
    return top[Math.floor(Math.random() * top.length)];
  },
};

export const hardBot: BotStrategy<AgonState, AgonMove> = {
  pickMove: (state, playerID) => {
    const me: PlayerId = playerID;
    const foe = opposite(me);
    const moves = legalMoves(state, me);
    if (moves.length === 0) throw new Error("hardBot: no legal move");
    let best = moves[0];
    let bestScore = -Infinity;
    let bestKey = "";
    for (const m of moves) {
      const after = applyMove(state, me, m);
      const res = checkResult(after);
      let score: number;
      if (res.status === "win") {
        score = res.winner === me ? INF : -INF;
      } else if (res.status === "draw") {
        score = 0;
      } else {
        // Opponent's best single reply (2-ply total).
        score = -negamax(after, foe, 1);
      }
      const key = JSON.stringify(m);
      if (score > bestScore || (score === bestScore && key < bestKey)) {
        bestScore = score;
        best = m;
        bestKey = key;
      }
    }
    return best;
  },
};
