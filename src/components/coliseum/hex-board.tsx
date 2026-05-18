/**
 * HexBoard — SVG renderer for the 11×11 hex grid.
 *
 * We render the rhombic board with offset coordinates: each row shifts
 * right by half a cell width. Cell hex polygons are drawn flat-topped.
 * The top + bottom edges get red stripes, left + right edges blue stripes,
 * matching the Red-connects-top-bottom / Blue-connects-left-right rule.
 */
import { cn } from "@/lib/utils";

const N = 11;

// Geometry in SVG units. We render flat-topped hexes; width:height ≈ 1.155:1.
// Each hex is sized to 1 SVG unit wide. Row offset = 0.5 (rhombic shift).
const HEX_W = 1;
const HEX_H = HEX_W * 1.155;
const ROW_OFFSET_X = 0.5;
const ROW_HEIGHT = HEX_H * 0.75; // overlapping rows
// Total content width includes the row-shift accumulation: N cells + (N-1) shifts.
const CONTENT_W = N * HEX_W + (N - 1) * ROW_OFFSET_X;
const CONTENT_H = HEX_H + (N - 1) * ROW_HEIGHT;
const PADDING = 0.6; // SVG-unit margin so the colored edges + last-move outline fit

// Flat-topped hex centered at (cx, cy) with given width.
function hexPath(cx: number, cy: number, w: number): string {
  const h = w * 1.155;
  // 6 vertices clockwise from top.
  const pts = [
    [cx,          cy - h / 2],
    [cx + w / 2,  cy - h / 4],
    [cx + w / 2,  cy + h / 4],
    [cx,          cy + h / 2],
    [cx - w / 2,  cy + h / 4],
    [cx - w / 2,  cy - h / 4],
  ];
  return pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(3)},${y.toFixed(3)}`).join(" ") + " Z";
}

function centerOf(row: number, col: number): [number, number] {
  const cx = PADDING + HEX_W / 2 + col * HEX_W + row * ROW_OFFSET_X;
  const cy = PADDING + HEX_H / 2 + row * ROW_HEIGHT;
  return [cx, cy];
}

export interface HexBoardProps {
  board?: string[] | null;
  lastMove?: { row: number; col: number } | null;
  className?: string;
}

const EMPTY: string[] = Array<string>(121).fill("");

export function HexBoard({ board, lastMove, className }: HexBoardProps) {
  const cells = board && board.length === 121 ? board : EMPTY;
  const viewW = CONTENT_W + 2 * PADDING;
  const viewH = CONTENT_H + 2 * PADDING;

  // Edge stripes — straight lines connecting the centers of the edge cells.
  const topEdge = (() => {
    const [x0, y0] = centerOf(0, 0);
    const [x1, y1] = centerOf(0, N - 1);
    return `M${x0.toFixed(3)},${(y0 - HEX_H / 2 - 0.15).toFixed(3)} L${x1.toFixed(3)},${(y1 - HEX_H / 2 - 0.15).toFixed(3)}`;
  })();
  const bottomEdge = (() => {
    const [x0, y0] = centerOf(N - 1, 0);
    const [x1, y1] = centerOf(N - 1, N - 1);
    return `M${x0.toFixed(3)},${(y0 + HEX_H / 2 + 0.15).toFixed(3)} L${x1.toFixed(3)},${(y1 + HEX_H / 2 + 0.15).toFixed(3)}`;
  })();
  const leftEdge = (() => {
    const [x0, y0] = centerOf(0, 0);
    const [x1, y1] = centerOf(N - 1, 0);
    return `M${(x0 - HEX_W / 2 - 0.15).toFixed(3)},${y0.toFixed(3)} L${(x1 - HEX_W / 2 - 0.15).toFixed(3)},${y1.toFixed(3)}`;
  })();
  const rightEdge = (() => {
    const [x0, y0] = centerOf(0, N - 1);
    const [x1, y1] = centerOf(N - 1, N - 1);
    return `M${(x0 + HEX_W / 2 + 0.15).toFixed(3)},${y0.toFixed(3)} L${(x1 + HEX_W / 2 + 0.15).toFixed(3)},${y1.toFixed(3)}`;
  })();

  const polygons: React.ReactNode[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const idx = r * N + c;
      const v = cells[idx];
      const [cx, cy] = centerOf(r, c);
      const cls = v === "R" ? "R" : v === "B" ? "B" : "";
      const isLast = lastMove?.row === r && lastMove?.col === c;
      polygons.push(
        <path
          key={`h-${r}-${c}`}
          d={hexPath(cx, cy, HEX_W * 0.96)}
          className={cn("cell", cls, isLast && "last")}
        />,
      );
    }
  }

  return (
    <div className={cn("hex-board", className)} aria-hidden="true">
      <svg viewBox={`0 0 ${viewW.toFixed(3)} ${viewH.toFixed(3)}`} preserveAspectRatio="xMidYMid meet">
        {polygons}
        {/* Edge stripes: red top + bottom, blue left + right */}
        <path d={topEdge} className="edge-r" />
        <path d={bottomEdge} className="edge-r" />
        <path d={leftEdge} className="edge-b" />
        <path d={rightEdge} className="edge-b" />
      </svg>
    </div>
  );
}
