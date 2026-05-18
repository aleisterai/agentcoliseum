/**
 * TakBoard — 5×5 grid SVG renderer.
 *
 * Each occupied cell shows either:
 *   - a flat (filled rectangle, large) — flats count for road.
 *   - a wall (narrow upright rectangle in the cell center) — walls block roads.
 *
 * Last-played cell gets a gold outline.
 */
import { cn } from "@/lib/utils";

const N = 5;
const CELL = 100 / (N + 0.5);
const PAD = CELL / 4;

function cellOrigin(row: number, col: number): [number, number] {
  return [PAD + col * CELL, PAD + row * CELL];
}

interface TakPiece {
  side: "0" | "1";
  kind: "F" | "W";
}

export interface TakBoardProps {
  cells?: Array<TakPiece | null> | null;
  lastMove?: { to: { row: number; col: number }; kind: "F" | "W" } | null;
  className?: string;
}

const EMPTY: Array<TakPiece | null> = Array<TakPiece | null>(25).fill(null);

export function TakBoard({ cells, lastMove, className }: TakBoardProps) {
  const c = cells && cells.length === 25 ? cells : EMPTY;
  const nodes: React.ReactNode[] = [];
  for (let r = 0; r < N; r++) {
    for (let col = 0; col < N; col++) {
      const [x, y] = cellOrigin(r, col);
      nodes.push(
        <rect
          key={`bg-${r}-${col}`}
          x={x + 0.3}
          y={y + 0.3}
          width={CELL - 0.6}
          height={CELL - 0.6}
          rx={1.0}
          className="cell-bg"
        />,
      );
      const piece = c[r * N + col];
      if (!piece) continue;
      const isLast = lastMove?.to.row === r && lastMove?.to.col === col;
      const side = piece.side === "0" ? "p0" : "p1";
      if (piece.kind === "F") {
        nodes.push(
          <rect
            key={`p-${r}-${col}`}
            x={x + CELL * 0.18}
            y={y + CELL * 0.18}
            width={CELL * 0.64}
            height={CELL * 0.64}
            rx={1.2}
            className={cn("flat", side, isLast && "last")}
          />,
        );
      } else {
        // Wall — narrow upright rectangle
        nodes.push(
          <rect
            key={`w-${r}-${col}`}
            x={x + CELL * 0.42}
            y={y + CELL * 0.08}
            width={CELL * 0.16}
            height={CELL * 0.84}
            rx={0.4}
            className={cn("wall", side, isLast && "last")}
          />,
        );
      }
    }
  }
  return (
    <div className={cn("tak-board", className)} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
        {nodes}
      </svg>
    </div>
  );
}
