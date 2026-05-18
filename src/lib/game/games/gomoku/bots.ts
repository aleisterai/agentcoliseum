/**
 * Gomoku system bots.
 *
 * Gomoku's branching factor (~225 at the empty board) makes deep search
 * intractable without aggressive move pruning. Standard trick: only
 * consider squares within radius R of an existing stone. With R=1 the
 * effective branching factor drops to ~12 in the early game, ~30 in the
 * mid-game — totally tractable for depth-2 / depth-3 search.
 *
 *   easy   → random legal move (with mild bias toward the center).
 *   medium → 1-ply tactical: win-if-can, block-4-threat, else
 *            best-pattern square.
 *   hard   → depth-2 negamax + alpha-beta over "active" squares only,
 *            with a pattern-based evaluator (open-4, broken-4, open-3, …).
 *            Strong enough to never lose to an inattentive opponent.
 */
import type { BotStrategy } from "@/lib/game/types";
import {
  SIZE,
  WIN_LEN,
  applyMove,
  checkResult,
  indexOf,
  inBounds,
  legalMoves,
  opposite,
  type Board,
  type GomokuMove,
  type GomokuState,
  type Side,
} from "./game";

const WIN_SCORE = 1_000_000;
const CENTER = Math.floor(SIZE / 2);

/* Pattern weights — open ends = bigger threat. */
const PATTERN_SCORE: Record<string, number> = {
  // 5 in a row already counts as a win — never reached via evaluator.
  open4: 100_000, // _XXXX_  — guaranteed win next move
  closed4: 1_000, // XXXX_ or _XXXX with one end blocked
  broken4: 1_000, // X_XXX, XX_XX, XXX_X with five-line potential
  open3: 1_000, // _XXX_
  closed3: 100,
  broken3: 100, // X_XX or XX_X
  open2: 50,
  closed2: 10,
};

/**
 * Enumerate the squares within `radius` of any non-empty cell — the
 * candidate moves the search will consider. On a board with N stones,
 * this is at most (2R+1)^2 × N but typically much less due to overlap.
 */
function activeSquares(board: Board, radius = 1): GomokuMove[] {
  const seen = new Set<number>();
  const out: GomokuMove[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[indexOf(r, c)] === "") continue;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (!inBounds(nr, nc)) continue;
          if (board[indexOf(nr, nc)] !== "") continue;
          const key = nr * SIZE + nc;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ row: nr, col: nc });
        }
      }
    }
  }
  // First move case: nothing on the board → play center.
  if (out.length === 0) out.push({ row: CENTER, col: CENTER });
  return out;
}

/**
 * Score a single line direction starting from (r, c) for the given side.
 * Walks both directions, counts contiguous + broken runs, returns the
 * highest-scoring pattern found. The evaluator sums per-cell scores to
 * get the static evaluation.
 */
function lineScoreAt(board: Board, r: number, c: number, side: Side): number {
  const opp = opposite(side);
  let total = 0;
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const) {
    // Walk back to find the start of any run that includes this cell.
    let pre = 0;
    let pr = r - dr;
    let pc = c - dc;
    while (inBounds(pr, pc) && board[indexOf(pr, pc)] === side) {
      pre++;
      pr -= dr;
      pc -= dc;
    }
    let post = 0;
    let nr = r + dr;
    let nc = c + dc;
    while (inBounds(nr, nc) && board[indexOf(nr, nc)] === side) {
      post++;
      nr += dr;
      nc += dc;
    }
    const len = 1 + pre + post; // run length including this cell
    const openBack = inBounds(pr, pc) && board[indexOf(pr, pc)] === "";
    const openFront = inBounds(nr, nc) && board[indexOf(nr, nc)] === "";
    const openEnds = (openBack ? 1 : 0) + (openFront ? 1 : 0);
    // Block penalty: a run with both ends blocked by opp pieces is dead.
    const backBlocked = inBounds(pr, pc) && board[indexOf(pr, pc)] === opp;
    const frontBlocked = inBounds(nr, nc) && board[indexOf(nr, nc)] === opp;
    if ((backBlocked || !inBounds(pr, pc)) && (frontBlocked || !inBounds(nr, nc)) && len < WIN_LEN) {
      continue; // dead line — no contribution
    }
    if (len >= WIN_LEN) return WIN_SCORE;
    if (len === 4) total += openEnds === 2 ? PATTERN_SCORE.open4 : PATTERN_SCORE.closed4;
    else if (len === 3) total += openEnds === 2 ? PATTERN_SCORE.open3 : PATTERN_SCORE.closed3;
    else if (len === 2) total += openEnds === 2 ? PATTERN_SCORE.open2 : PATTERN_SCORE.closed2;
  }
  return total;
}

/**
 * Static evaluation from `perspective`'s POV. Sums lineScoreAt across
 * every stone on the board. Positive favors `perspective`.
 */
function evaluate(state: GomokuState, perspective: Side): number {
  let score = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = state.board[indexOf(r, c)];
      if (v === "") continue;
      const ls = lineScoreAt(state.board, r, c, v);
      score += v === perspective ? ls : -ls;
    }
  }
  return score;
}

/**
 * Detect if `side` wins by playing at (row, col) (immediate WIN_LEN).
 */
function immediateWin(board: Board, row: number, col: number, side: Side): boolean {
  if (board[indexOf(row, col)] !== "") return false;
  // Temporarily place and re-use the line-from-move check.
  const test = board.slice() as Board;
  test[indexOf(row, col)] = side;
  // Walk each direction from (row, col).
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const) {
    let count = 1;
    let r = row + dr;
    let c = col + dc;
    while (inBounds(r, c) && test[indexOf(r, c)] === side) {
      count++;
      r += dr;
      c += dc;
    }
    r = row - dr;
    c = col - dc;
    while (inBounds(r, c) && test[indexOf(r, c)] === side) {
      count++;
      r -= dr;
      c -= dc;
    }
    if (count >= WIN_LEN) return true;
  }
  return false;
}

function orderMoves(state: GomokuState, moves: GomokuMove[]): GomokuMove[] {
  // Order by static line-score of placing here (the higher, the more
  // promising the move). This makes alpha-beta cut deeply pruned branches
  // first, which is huge for gomoku where most squares are noise.
  return moves
    .map((m) => {
      const next = applyMove(state, m);
      return { m, score: evaluate(next, state.turn) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 14) // top 14 — enough to find tactical moves, fast
    .map((x) => x.m);
}

function negamax(state: GomokuState, depth: number, alpha: number, beta: number): number {
  const result = checkResult(state);
  if (result.status === "win") return -WIN_SCORE + (1000 - depth);
  if (result.status === "draw") return 0;
  if (depth === 0) return evaluate(state, state.turn);

  const moves = orderMoves(state, activeSquares(state.board, 1));
  let best = -Infinity;
  for (const m of moves) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -beta, -alpha);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickBestMove(state: GomokuState, depth: number): GomokuMove {
  const me = state.turn;
  const opp = opposite(me);
  const candidates = activeSquares(state.board, 1);

  // Immediate-win check first — no search needed.
  for (const m of candidates) {
    if (immediateWin(state.board, m.row, m.col, me)) return m;
  }
  // Block opponent's immediate win.
  for (const m of candidates) {
    if (immediateWin(state.board, m.row, m.col, opp)) return m;
  }

  let bestMove = candidates[0];
  let bestScore = -Infinity;
  for (const m of orderMoves(state, candidates)) {
    const next = applyMove(state, m);
    const score = -negamax(next, depth - 1, -Infinity, Infinity);
    if (score > bestScore) {
      bestScore = score;
      bestMove = m;
    }
  }
  return bestMove;
}

export const easyBot: BotStrategy<GomokuState, GomokuMove> = {
  pickMove: (state) => {
    // Mild bias: prefer squares near the center on the first few moves.
    const moves = legalMoves(state);
    if (moves.length === 0) throw new Error("easyBot called with no legal moves");
    if (state.moveCount < 4) {
      const near = moves.filter(
        (m) => Math.abs(m.row - CENTER) <= 3 && Math.abs(m.col - CENTER) <= 3,
      );
      if (near.length > 0) return near[Math.floor(Math.random() * near.length)];
    }
    return moves[Math.floor(Math.random() * moves.length)];
  },
};

export const mediumBot: BotStrategy<GomokuState, GomokuMove> = {
  pickMove: (state) => {
    const me = state.turn;
    const opp = opposite(me);
    const candidates = activeSquares(state.board, 1);
    // 1-ply: win-if-can, block-if-must, else best static eval.
    for (const m of candidates) {
      if (immediateWin(state.board, m.row, m.col, me)) return m;
    }
    for (const m of candidates) {
      if (immediateWin(state.board, m.row, m.col, opp)) return m;
    }
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const m of candidates) {
      const next = applyMove(state, m);
      const score = evaluate(next, me);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  },
};

export const hardBot: BotStrategy<GomokuState, GomokuMove> = {
  pickMove: (state) => pickBestMove(state, 2),
};
