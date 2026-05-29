/**
 * FanoronaBoard — 5×9 intersection board for Fanorona.
 *
 * Renders the line network (orthogonal lines everywhere, diagonals only at
 * "strong" intersections where (row+col) is even) plus pieces on the nodes.
 * Player 0 = light disc, player 1 = oxblood disc (classic light-vs-red; never
 * gold — gold is reserved for money in the design system). The last move's
 * landing node is ringed in the accent colour. Theme-aware via CSS variables.
 */
import { cn } from "@/lib/utils";

type Cell = "" | "0" | "1";

export interface FanoronaBoardProps {
  board?: Cell[] | null;
  /** Most recent move; we ring its landing node. */
  lastMove?: { from?: number; to?: number } | null;
  className?: string;
}

const COLS = 9;
const ROWS = 5;
const N = COLS * ROWS;
const EMPTY: Cell[] = Array<Cell>(N).fill("");

const STEP = 40;
const PAD = 24;
const W = (COLS - 1) * STEP + PAD * 2; // 368
const H = (ROWS - 1) * STEP + PAD * 2; // 208

const rowOf = (i: number) => Math.floor(i / COLS);
const colOf = (i: number) => i % COLS;
const px = (c: number) => PAD + c * STEP;
const py = (r: number) => PAD + r * STEP;

/** All board line segments, each drawn exactly once. */
function buildSegments(): Array<[number, number, number, number]> {
  const segs: Array<[number, number, number, number]> = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = px(c);
      const y = py(r);
      // East + South orthogonals (each orthogonal edge drawn once).
      if (c + 1 < COLS) segs.push([x, y, px(c + 1), y]);
      if (r + 1 < ROWS) segs.push([x, y, x, py(r + 1)]);
      // Downward diagonals from strong points only (each diagonal edge once).
      if ((r + c) % 2 === 0) {
        if (r + 1 < ROWS && c + 1 < COLS) segs.push([x, y, px(c + 1), py(r + 1)]);
        if (r + 1 < ROWS && c - 1 >= 0) segs.push([x, y, px(c - 1), py(r + 1)]);
      }
    }
  }
  return segs;
}

const SEGMENTS = buildSegments();

export function FanoronaBoard({ board, lastMove, className }: FanoronaBoardProps) {
  const cells = board && board.length === N ? board : EMPTY;
  const lastTo = typeof lastMove?.to === "number" ? lastMove.to : null;
  const lastFrom = typeof lastMove?.from === "number" ? lastMove.from : null;

  return (
    <svg
      className={cn(className)}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Fanorona board"
      style={{
        width: "100%",
        height: "auto",
        background: "var(--bg-2)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        display: "block",
      }}
    >
      {/* Line network */}
      <g stroke="var(--line)" strokeWidth={1.5} strokeLinecap="round">
        {SEGMENTS.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>
      {/* Nodes + pieces */}
      {cells.map((cell, i) => {
        const x = px(colOf(i));
        const y = py(rowOf(i));
        const isLastTo = lastTo === i;
        const isLastFrom = lastFrom === i;
        return (
          <g key={i}>
            {/* empty intersection dot */}
            {cell === "" ? (
              <circle cx={x} cy={y} r={2.5} fill="var(--line)" />
            ) : (
              <circle
                cx={x}
                cy={y}
                r={13}
                fill={cell === "0" ? "var(--text-1)" : "var(--ox-bright)"}
                stroke={cell === "0" ? "var(--line)" : "transparent"}
                strokeWidth={1}
              />
            )}
            {isLastFrom && cell === "" ? (
              <circle
                cx={x}
                cy={y}
                r={6}
                fill="none"
                stroke="color-mix(in oklab, var(--accent) 45%, transparent)"
                strokeWidth={2}
                strokeDasharray="2 2"
              />
            ) : null}
            {isLastTo ? (
              <circle
                cx={x}
                cy={y}
                r={16}
                fill="none"
                stroke="color-mix(in oklab, var(--accent) 75%, transparent)"
                strokeWidth={2}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
