/**
 * Chess system bots.
 *
 *   easy   → random legal move
 *   medium → negamax depth 2 with material-only evaluator
 *   hard   → negamax depth 4 with material + piece-square tables + alpha-beta
 *
 * Deterministic for a given (state, playerID). Tests rely on this.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  applyMove,
  checkResult,
  isInCheck,
  legalMoves,
  squareName,
  type ChessState,
  type Move,
  type Piece,
  type Side,
} from "./game";

const MATE_SCORE = 1_000_000;
const STALEMATE_SCORE = 0;

// Material values (centipawns).
const MATERIAL: Record<Piece[1] & string, number> = {
  P: 100,
  N: 320,
  B: 330,
  R: 500,
  Q: 900,
  K: 20_000,
};

// Piece-square tables, oriented from White's perspective. Flipped for Black.
// Values nudge piece placement: knights toward the center, pawns forward, etc.
// Modest scale (centipawns), keeps material the dominant signal.
// Tables read row-major from rank 8 to rank 1 (same orientation as our board).
// prettier-ignore
const PST: Record<Piece[1] & string, number[]> = {
  P: [
    0,  0,  0,  0,  0,  0,  0,  0,
   50, 50, 50, 50, 50, 50, 50, 50,
   10, 10, 20, 30, 30, 20, 10, 10,
    5,  5, 10, 25, 25, 10,  5,  5,
    0,  0,  0, 20, 20,  0,  0,  0,
    5, -5,-10,  0,  0,-10, -5,  5,
    5, 10, 10,-20,-20, 10, 10,  5,
    0,  0,  0,  0,  0,  0,  0,  0,
  ],
  N: [
   -50,-40,-30,-30,-30,-30,-40,-50,
   -40,-20,  0,  0,  0,  0,-20,-40,
   -30,  0, 10, 15, 15, 10,  0,-30,
   -30,  5, 15, 20, 20, 15,  5,-30,
   -30,  0, 15, 20, 20, 15,  0,-30,
   -30,  5, 10, 15, 15, 10,  5,-30,
   -40,-20,  0,  5,  5,  0,-20,-40,
   -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  B: [
   -20,-10,-10,-10,-10,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5, 10, 10,  5,  0,-10,
   -10,  5,  5, 10, 10,  5,  5,-10,
   -10,  0, 10, 10, 10, 10,  0,-10,
   -10, 10, 10, 10, 10, 10, 10,-10,
   -10,  5,  0,  0,  0,  0,  5,-10,
   -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  R: [
    0,  0,  0,  0,  0,  0,  0,  0,
    5, 10, 10, 10, 10, 10, 10,  5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
    0,  0,  0,  5,  5,  0,  0,  0,
  ],
  Q: [
   -20,-10,-10, -5, -5,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5,  5,  5,  5,  0,-10,
    -5,  0,  5,  5,  5,  5,  0, -5,
     0,  0,  5,  5,  5,  5,  0, -5,
   -10,  5,  5,  5,  5,  5,  0,-10,
   -10,  0,  5,  0,  0,  0,  0,-10,
   -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  K: [
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -20,-30,-30,-40,-40,-30,-30,-20,
   -10,-20,-20,-20,-20,-20,-20,-10,
    20, 20,  0,  0,  0,  0, 20, 20,
    20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

/**
 * Static evaluation, centipawns, from `perspective`'s point of view.
 * Positive = good for perspective.
 */
function evaluate(state: ChessState, perspective: Side, useTables: boolean): number {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p === "") continue;
    const side = p[0] as Side;
    const kind = p[1] as Piece[1] & string;
    let v = MATERIAL[kind];
    if (useTables) {
      const tableIdx = side === "W" ? i : 63 - i;
      v += PST[kind][tableIdx];
    }
    score += side === perspective ? v : -v;
  }
  return score;
}

/**
 * Order moves to improve alpha-beta pruning. Captures first (MVV-LVA-ish),
 * promotions next, quiet moves last.
 */
function orderMoves(state: ChessState, moves: Move[]): Move[] {
  return moves.slice().sort((a, b) => score(b) - score(a));
  function score(m: Move): number {
    let s = 0;
    const victim = state.board[m.to];
    if (victim !== "") s += 10 * MATERIAL[victim[1] as Piece[1] & string];
    const attacker = state.board[m.from];
    if (attacker !== "") s -= MATERIAL[attacker[1] as Piece[1] & string];
    if (m.promotion) s += MATERIAL[m.promotion];
    return s;
  }
}

/**
 * Standard negamax: score is always from the perspective of the side to
 * move in `state`. The caller (one ply up) negates because their side is
 * the opposite color.
 */
function negamax(
  state: ChessState,
  depth: number,
  alpha: number,
  beta: number,
  useTables: boolean,
): number {
  const result = checkResult(state);
  if (result.status === "win") {
    // A terminal "win" here means the side to move (state.turn) has been
    // checkmated by `result.winner`. From state.turn's POV, that's a loss.
    // Quicker losses score less badly (push them deeper) so the engine
    // both prefers fast mates and delays inevitable losses.
    return -MATE_SCORE + (1000 - depth);
  }
  if (result.status === "draw") return STALEMATE_SCORE;
  if (depth === 0) {
    return evaluate(state, state.turn, useTables);
  }

  const moves = orderMoves(state, legalMoves(state));
  let best = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -beta, -alpha, useTables);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickBestMove(state: ChessState, depth: number, useTables: boolean): Move {
  const moves = orderMoves(state, legalMoves(state));
  if (moves.length === 0) throw new Error("pickBestMove called on a finished board");
  let bestMove = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    // After applying our move it's the opponent's turn. Their best score
    // (from their POV) is what negamax returns; we want OUR score, so negate.
    const score = -negamax(next, depth - 1, -Infinity, Infinity, useTables);
    if (score > bestScore) {
      bestScore = score;
      bestMove = m;
    }
  }
  return bestMove;
}

function moveAsPayload(move: Move): {
  from: string;
  to: string;
  promotion?: "Q" | "R" | "B" | "N";
} {
  return {
    from: squareName(move.from),
    to: squareName(move.to),
    ...(move.promotion ? { promotion: move.promotion } : {}),
  };
}

export const easyBot: BotStrategy<ChessState, { from: string; to: string; promotion?: "Q" | "R" | "B" | "N" }> = {
  pickMove: (state) => {
    const legal = legalMoves(state);
    if (legal.length === 0) throw new Error("easyBot called on a finished board");
    // Deterministic-ish: prefer captures, then random among remaining.
    const captures = legal.filter((m) => state.board[m.to] !== "");
    const pool = captures.length > 0 ? captures : legal;
    return moveAsPayload(pool[Math.floor(Math.random() * pool.length)]);
  },
};

export const mediumBot: BotStrategy<ChessState, { from: string; to: string; promotion?: "Q" | "R" | "B" | "N" }> = {
  pickMove: (state) => moveAsPayload(pickBestMove(state, 2, false)),
};

export const hardBot: BotStrategy<ChessState, { from: string; to: string; promotion?: "Q" | "R" | "B" | "N" }> = {
  pickMove: (state) => moveAsPayload(pickBestMove(state, 4, true)),
};

// Re-exports so callers (like the API contract examples) can verify legality
// before constructing payloads.
export { isInCheck };
