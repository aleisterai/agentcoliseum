/**
 * QuoridorBoard — SVG renderer for the 9×9 board, two pawns, and the
 * 8×8 lattice of wall slots.
 *
 * Geometry (100×100 viewBox):
 *   - 9 cells per side, each ~10 units wide.
 *   - Walls render as fat 2-cell-long rectangles in the gap between cells.
 */
import { cn } from "@/lib/utils";

const N = 9;
const CELL = 100 / (N + 1);
const PAD = CELL / 2;
const WALL_THICK = CELL * 0.18;

function cellCenter(row: number, col: number): [number, number] {
  return [PAD + col * CELL + CELL / 2, PAD + row * CELL + CELL / 2];
}

export interface QuoridorBoardProps {
  pawns?: { "0": { row: number; col: number }; "1": { row: number; col: number } } | null;
  hWalls?: boolean[] | null;
  vWalls?: boolean[] | null;
  lastMove?: {
    kind: "pawn" | "wall";
    to?: { row: number; col: number };
    wall?: { type: "h" | "v"; row: number; col: number };
  } | null;
  className?: string;
}

const EMPTY_WALLS: boolean[] = Array<boolean>(64).fill(false);

export function QuoridorBoard({ pawns, hWalls, vWalls, lastMove, className }: QuoridorBoardProps) {
  const p0 = pawns?.["0"] ?? { row: 0, col: 4 };
  const p1 = pawns?.["1"] ?? { row: 8, col: 4 };
  const h = hWalls && hWalls.length === 64 ? hWalls : EMPTY_WALLS;
  const v = vWalls && vWalls.length === 64 ? vWalls : EMPTY_WALLS;

  const cellRects: React.ReactNode[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      cellRects.push(
        <rect
          key={`c-${r}-${c}`}
          x={PAD + c * CELL + 0.5}
          y={PAD + r * CELL + 0.5}
          width={CELL - 1}
          height={CELL - 1}
          rx={0.6}
          className="cell"
        />,
      );
    }
  }

  // Horizontal walls: span columns c..c+1, between rows r and r+1.
  const walls: React.ReactNode[] = [];
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      const idx = r * (N - 1) + c;
      if (h[idx]) {
        const x = PAD + c * CELL + 0.5;
        const y = PAD + (r + 1) * CELL - WALL_THICK / 2;
        const isLast = lastMove?.kind === "wall" && lastMove.wall?.type === "h" && lastMove.wall.row === r && lastMove.wall.col === c;
        walls.push(<rect key={`hw-${r}-${c}`} x={x} y={y} width={2 * CELL - 1} height={WALL_THICK} className={cn("wall", isLast && "last")} rx={0.4} />);
      }
      if (v[idx]) {
        const x = PAD + (c + 1) * CELL - WALL_THICK / 2;
        const y = PAD + r * CELL + 0.5;
        const isLast = lastMove?.kind === "wall" && lastMove.wall?.type === "v" && lastMove.wall.row === r && lastMove.wall.col === c;
        walls.push(<rect key={`vw-${r}-${c}`} x={x} y={y} width={WALL_THICK} height={2 * CELL - 1} className={cn("wall", isLast && "last")} rx={0.4} />);
      }
    }
  }

  const [cx0, cy0] = cellCenter(p0.row, p0.col);
  const [cx1, cy1] = cellCenter(p1.row, p1.col);

  return (
    <div className={cn("quoridor-board", className)} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
        {cellRects}
        {walls}
        <circle cx={cx0} cy={cy0} r={CELL * 0.32} className="pawn p0" />
        <circle cx={cx1} cy={cy1} r={CELL * 0.32} className="pawn p1" />
      </svg>
    </div>
  );
}
