/**
 * DotsAndBoxesBoard — SVG renderer for the 5×5 dot lattice + 4×4 boxes.
 *
 * Coordinates inside the SVG use a normalized 100×100 viewport with the
 * dot grid evenly spaced. Edges that haven't been drawn render as a thin
 * dim line (so the structure is visible); drawn edges render as a
 * thicker, full-contrast line. The most recent edge is colored
 * `--ox-bright`.
 *
 * Box ownership is shown as a translucent fill (red for player 0, gold
 * for player 1) inside each claimed box.
 *
 * `N` here matches the engine's N — the 5×5 dot lattice. If we change
 * the board size on the engine side, this stays in sync.
 */
import { cn } from "@/lib/utils";

const N = 5;
const PADDING = 10; // viewport coords; dots are inset from the box edge
const SPAN = 100 - 2 * PADDING;
const STEP = SPAN / (N - 1); // distance between adjacent dots
const DOT_R = 1.4;
const HE_COUNT = N * (N - 1);
const VE_COUNT = (N - 1) * N;
const BOX_COUNT = (N - 1) * (N - 1);

export interface DotsAndBoxesBoardProps {
  hEdges?: boolean[] | null;
  vEdges?: boolean[] | null;
  boxes?: Array<"" | "0" | "1"> | null;
  lastMove?: { type: "h" | "v"; row: number; col: number } | null;
  className?: string;
}

function dotXY(row: number, col: number): [number, number] {
  return [PADDING + col * STEP, PADDING + row * STEP];
}

export function DotsAndBoxesBoard({
  hEdges,
  vEdges,
  boxes,
  lastMove,
  className,
}: DotsAndBoxesBoardProps) {
  const h = hEdges && hEdges.length === HE_COUNT ? hEdges : Array(HE_COUNT).fill(false);
  const v = vEdges && vEdges.length === VE_COUNT ? vEdges : Array(VE_COUNT).fill(false);
  const b = boxes && boxes.length === BOX_COUNT ? boxes : Array(BOX_COUNT).fill("");

  // Box fills first (under the lines).
  const boxRects: React.ReactNode[] = [];
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      const owner = b[r * (N - 1) + c];
      if (owner === "" || (owner !== "0" && owner !== "1")) continue;
      const [x0, y0] = dotXY(r, c);
      boxRects.push(
        <rect
          key={`box-${r}-${c}`}
          x={x0}
          y={y0}
          width={STEP}
          height={STEP}
          className={`box-${owner}`}
        />,
      );
    }
  }

  // Edges.
  const edges: React.ReactNode[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N - 1; c++) {
      const idx = r * (N - 1) + c;
      const drawn = h[idx];
      const isLast = lastMove?.type === "h" && lastMove.row === r && lastMove.col === c;
      const [x1, y1] = dotXY(r, c);
      const [x2, y2] = dotXY(r, c + 1);
      edges.push(
        <line
          key={`h-${r}-${c}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          className={cn(drawn ? "edge-drawn" : "edge-open", drawn && isLast && "last")}
        />,
      );
    }
  }
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N; c++) {
      const idx = r * N + c;
      const drawn = v[idx];
      const isLast = lastMove?.type === "v" && lastMove.row === r && lastMove.col === c;
      const [x1, y1] = dotXY(r, c);
      const [x2, y2] = dotXY(r + 1, c);
      edges.push(
        <line
          key={`v-${r}-${c}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          className={cn(drawn ? "edge-drawn" : "edge-open", drawn && isLast && "last")}
        />,
      );
    }
  }

  // Dots last so they sit above edges.
  const dots: React.ReactNode[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const [x, y] = dotXY(r, c);
      dots.push(<circle key={`d-${r}-${c}`} cx={x} cy={y} r={DOT_R} className="dot" />);
    }
  }

  return (
    <div className={cn("dab-board", className)} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
        {boxRects}
        {edges}
        {dots}
      </svg>
    </div>
  );
}
