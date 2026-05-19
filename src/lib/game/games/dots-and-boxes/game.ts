/**
 * Dots & Boxes — pure rules engine + boardgame.io game definition.
 *
 * Standard 5×5 dot lattice (4×4 = 16 boxes). Players alternate turns. On
 * your turn you draw a single edge (horizontal or vertical) between two
 * adjacent unconnected dots. If that edge completes the fourth side of
 * one or more boxes, you score one point per box AND you must move
 * again (the turn does not pass). Continue moving as long as each move
 * completes at least one box.
 *
 * The game ends when all edges are drawn. Winner: whoever owns more
 * boxes. 8-8 is possible (16 boxes split evenly) → draw.
 *
 * Coordinates:
 *   - DOTS:       (row, col) with 0 ≤ row, col < N (N=5 here)
 *   - HORIZONTAL EDGE (row, col): the edge BELOW dot (row, col), going to
 *     dot (row+1, col). Indexed for row in 0..N-2 and col in 0..N-1.
 *     We store hEdges as a flat (N-1) × N row-major array.
 *   - VERTICAL EDGE (row, col): the edge RIGHT OF dot (row, col), going
 *     to dot (row, col+1). Indexed for row in 0..N-1 and col in 0..N-2.
 *     We store vEdges as a flat N × (N-1) row-major array.
 *   - BOX (row, col): the cell whose top-left dot is (row, col). For
 *     box (r, c), its four edges are:
 *       top:    vEdges? no — top is the HORIZONTAL edge ABOVE the box.
 *               Wait, let's be careful. The box at (r,c) has corners
 *               (r,c), (r,c+1), (r+1,c), (r+1,c+1). Its four edges are:
 *       top    = hEdges[r][c]      → wait this is the edge from
 *                                    (r,c) to (r+1,c) vertically? No.
 *
 *     Let me redefine clearly. We treat:
 *       hEdges[r][c]   = the horizontal segment between (r, c) and
 *                        (r, c+1). r in 0..N-1, c in 0..N-2.
 *       vEdges[r][c]   = the vertical segment between (r, c) and
 *                        (r+1, c). r in 0..N-2, c in 0..N-1.
 *
 *     Then the box at (r, c) (top-left at dot (r,c), bottom-right at
 *     dot (r+1, c+1)) has these four edges:
 *       top    = hEdges[r    ][c]   (between (r,c) and (r,c+1))
 *       bottom = hEdges[r + 1][c]   (between (r+1,c) and (r+1,c+1))
 *       left   = vEdges[r    ][c]   (between (r,c) and (r+1,c))
 *       right  = vEdges[r    ][c+1] (between (r,c+1) and (r+1,c+1))
 *
 *     Counts: hEdges is N × (N-1); vEdges is (N-1) × N. Boxes are
 *     (N-1) × (N-1).
 */
import { INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";

export const N = 5; // 5×5 dot lattice → 4×4 = 16 boxes
export const HE_ROWS = N;        // hEdges rows
export const HE_COLS = N - 1;    // hEdges cols
export const VE_ROWS = N - 1;    // vEdges rows
export const VE_COLS = N;        // vEdges cols
export const BOX_ROWS = N - 1;   // 4
export const BOX_COLS = N - 1;   // 4
export const TOTAL_BOXES = BOX_ROWS * BOX_COLS;

export type PlayerId = "0" | "1";
export type BoxOwner = "" | PlayerId;

export interface DotsBoxesMove {
  type: "h" | "v";
  row: number;
  col: number;
}

export interface DotsBoxesState {
  hEdges: boolean[]; // length HE_ROWS * HE_COLS
  vEdges: boolean[]; // length VE_ROWS * VE_COLS
  boxes: BoxOwner[]; // length BOX_ROWS * BOX_COLS
  turn: PlayerId;
  scores: { "0": number; "1": number };
  lastMove: DotsBoxesMove | null;
}

export type DotsBoxesResult =
  | { status: "ongoing" }
  | { status: "win"; winner: PlayerId; scores: { "0": number; "1": number } }
  | { status: "draw"; scores: { "0": number; "1": number } };

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

export function hIndex(row: number, col: number): number {
  return row * HE_COLS + col;
}
export function vIndex(row: number, col: number): number {
  return row * VE_COLS + col;
}
export function boxIndex(row: number, col: number): number {
  return row * BOX_COLS + col;
}
export function inHBounds(row: number, col: number): boolean {
  return row >= 0 && row < HE_ROWS && col >= 0 && col < HE_COLS;
}
export function inVBounds(row: number, col: number): boolean {
  return row >= 0 && row < VE_ROWS && col >= 0 && col < VE_COLS;
}
export function inBoxBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOX_ROWS && col >= 0 && col < BOX_COLS;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function startingState(): DotsBoxesState {
  return {
    hEdges: Array<boolean>(HE_ROWS * HE_COLS).fill(false),
    vEdges: Array<boolean>(VE_ROWS * VE_COLS).fill(false),
    boxes: Array<BoxOwner>(BOX_ROWS * BOX_COLS).fill(""),
    turn: "0",
    scores: { "0": 0, "1": 0 },
    lastMove: null,
  };
}

export function cloneState(s: DotsBoxesState): DotsBoxesState {
  return {
    hEdges: s.hEdges.slice(),
    vEdges: s.vEdges.slice(),
    boxes: s.boxes.slice() as BoxOwner[],
    turn: s.turn,
    scores: { "0": s.scores["0"], "1": s.scores["1"] },
    lastMove: s.lastMove ? { ...s.lastMove } : null,
  };
}

export function opposite(p: PlayerId): PlayerId {
  return p === "0" ? "1" : "0";
}

// ---------------------------------------------------------------------------
// Box-side counting
// ---------------------------------------------------------------------------

/**
 * Returns how many of box (br, bc)'s four edges are currently drawn.
 * Used by bots to detect "third-side" positions to avoid (or take).
 */
export function sidesOfBox(state: DotsBoxesState, br: number, bc: number): number {
  let n = 0;
  if (state.hEdges[hIndex(br, bc)]) n++;            // top
  if (state.hEdges[hIndex(br + 1, bc)]) n++;        // bottom
  if (state.vEdges[vIndex(br, bc)]) n++;            // left
  if (state.vEdges[vIndex(br, bc + 1)]) n++;        // right
  return n;
}

/** Boxes adjacent to the given edge (1 if it's an edge of the lattice, 2 otherwise). */
function boxesAdjacentToEdge(move: DotsBoxesMove): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (move.type === "h") {
    // Horizontal edge between dot (row, col) and (row, col+1) bounds:
    //   - box ABOVE: (row-1, col) if row > 0
    //   - box BELOW: (row, col) if row < BOX_ROWS
    if (move.row > 0) out.push([move.row - 1, move.col]);
    if (move.row < BOX_ROWS) out.push([move.row, move.col]);
  } else {
    // Vertical edge between (row, col) and (row+1, col):
    //   - box LEFT: (row, col-1) if col > 0
    //   - box RIGHT: (row, col) if col < BOX_COLS
    if (move.col > 0) out.push([move.row, move.col - 1]);
    if (move.col < BOX_COLS) out.push([move.row, move.col]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Move legality
// ---------------------------------------------------------------------------

export function isEdgeDrawn(state: DotsBoxesState, move: DotsBoxesMove): boolean {
  if (move.type === "h") return state.hEdges[hIndex(move.row, move.col)] === true;
  return state.vEdges[vIndex(move.row, move.col)] === true;
}

export function isLegalMove(state: DotsBoxesState, move: DotsBoxesMove): boolean {
  if (move.type === "h") {
    if (!inHBounds(move.row, move.col)) return false;
    return !state.hEdges[hIndex(move.row, move.col)];
  }
  if (!inVBounds(move.row, move.col)) return false;
  return !state.vEdges[vIndex(move.row, move.col)];
}

export function legalMoves(state: DotsBoxesState): DotsBoxesMove[] {
  const out: DotsBoxesMove[] = [];
  for (let r = 0; r < HE_ROWS; r++) {
    for (let c = 0; c < HE_COLS; c++) {
      if (!state.hEdges[hIndex(r, c)]) out.push({ type: "h", row: r, col: c });
    }
  }
  for (let r = 0; r < VE_ROWS; r++) {
    for (let c = 0; c < VE_COLS; c++) {
      if (!state.vEdges[vIndex(r, c)]) out.push({ type: "v", row: r, col: c });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply move
// ---------------------------------------------------------------------------

export function applyMove(state: DotsBoxesState, move: DotsBoxesMove): DotsBoxesState {
  if (!isLegalMove(state, move)) {
    throw new Error(`illegal edge (${move.type}, ${move.row}, ${move.col})`);
  }
  const next = cloneState(state);
  const side = state.turn;
  if (move.type === "h") next.hEdges[hIndex(move.row, move.col)] = true;
  else next.vEdges[vIndex(move.row, move.col)] = true;

  // Check both adjacent boxes — if this edge completed a box, the moving
  // player claims it and gets another turn.
  let completed = 0;
  for (const [br, bc] of boxesAdjacentToEdge(move)) {
    if (!inBoxBounds(br, bc)) continue;
    if (next.boxes[boxIndex(br, bc)] !== "") continue;
    if (sidesOfBox(next, br, bc) === 4) {
      next.boxes[boxIndex(br, bc)] = side;
      next.scores[side] += 1;
      completed += 1;
    }
  }

  next.lastMove = { ...move };
  // Turn only flips if NO box was completed.
  if (completed === 0) next.turn = opposite(side);
  return next;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export function checkResult(state: DotsBoxesState): DotsBoxesResult {
  if (legalMoves(state).length === 0) {
    const s = state.scores;
    if (s["0"] > s["1"]) return { status: "win", winner: "0", scores: s };
    if (s["1"] > s["0"]) return { status: "win", winner: "1", scores: s };
    return { status: "draw", scores: s };
  }
  return { status: "ongoing" };
}

// ---------------------------------------------------------------------------
// boardgame.io Game definition
// ---------------------------------------------------------------------------

export const game: Game<DotsBoxesState> = {
  name: "dots-and-boxes",
  setup: () => startingState(),
  // Same pattern as mancala's bonus-turn rule (see comment there).
  // Closing the fourth side of a box keeps the turn on the same player;
  // `applyMove` reflects that in G.turn, so we must NOT let
  // boardgame.io's `maxMoves: 1` auto-advance ctx.currentPlayer or the
  // server records the wrong player as on-turn and every subsequent
  // move is rejected as INVALID_MOVE.
  turn: { minMoves: 1 },
  moves: {
    draw: ({ G, playerID, events }, raw: unknown) => {
      if (G.turn !== playerID) return INVALID_MOVE;
      const arg = raw as { type?: unknown; row?: unknown; col?: unknown };
      if (arg.type !== "h" && arg.type !== "v") return INVALID_MOVE;
      const row = Number(arg.row);
      const col = Number(arg.col);
      if (!Number.isInteger(row) || !Number.isInteger(col)) return INVALID_MOVE;
      const move: DotsBoxesMove = { type: arg.type, row, col };
      if (!isLegalMove(G, move)) return INVALID_MOVE;

      const next = applyMove(G, move);
      G.hEdges = next.hEdges;
      G.vEdges = next.vEdges;
      G.boxes = next.boxes;
      G.turn = next.turn;
      G.scores = next.scores;
      G.lastMove = next.lastMove;
      // Advance the boardgame.io turn iff this move did NOT close a box.
      // If applyMove left G.turn on the same player, they earned another
      // turn — boardgame.io must agree.
      if (G.turn !== playerID) events.endTurn();
    },
  },
  endIf: ({ G }) => {
    const r = checkResult(G);
    if (r.status === "win") return { winner: r.winner };
    if (r.status === "draw") return { draw: true };
  },
};
