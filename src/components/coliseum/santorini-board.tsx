/**
 * SantoriniBoard — 5×5 grid with stacked-floor visualization.
 *
 * Each cell renders:
 *   - Ground square (always)
 *   - Inset rectangles per floor (1..3) — stacked, getting smaller
 *   - A blue circle ("dome") if level === 4
 *   - The numeric level in the corner
 *   - A colored circle for any builder standing on it
 */
import { cn } from "@/lib/utils";

const N = 5;
const CELL = 100 / (N + 0.5); // small padding around the grid
const PAD = CELL / 4;

function cellOrigin(row: number, col: number): [number, number] {
  return [PAD + col * CELL, PAD + row * CELL];
}

function cellCenter(row: number, col: number): [number, number] {
  return [PAD + col * CELL + CELL / 2, PAD + row * CELL + CELL / 2];
}

export interface SantoriniBoardProps {
  levels?: number[] | null;
  builders?: {
    "0": [{ row: number; col: number }, { row: number; col: number }];
    "1": [{ row: number; col: number }, { row: number; col: number }];
  } | null;
  className?: string;
}

const DEFAULT_LEVELS: number[] = Array<number>(25).fill(0);

export function SantoriniBoard({ levels, builders, className }: SantoriniBoardProps) {
  const l = levels && levels.length === 25 ? levels : DEFAULT_LEVELS;
  const b0 = builders?.["0"] ?? [{ row: 0, col: 1 }, { row: 0, col: 3 }];
  const b1 = builders?.["1"] ?? [{ row: 4, col: 1 }, { row: 4, col: 3 }];

  const cells: React.ReactNode[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const idx = r * N + c;
      const lvl = l[idx];
      const [x, y] = cellOrigin(r, c);
      // Ground rect
      cells.push(
        <rect
          key={`g-${r}-${c}`}
          x={x + 0.4}
          y={y + 0.4}
          width={CELL - 0.8}
          height={CELL - 0.8}
          rx={1.4}
          className="ground"
        />,
      );
      // Floors: render inset rects for level 1, 2, 3
      for (let f = 1; f <= 3 && f <= lvl; f++) {
        const inset = f * 1.0;
        cells.push(
          <rect
            key={`f-${r}-${c}-${f}`}
            x={x + inset}
            y={y + inset}
            width={CELL - inset * 2}
            height={CELL - inset * 2}
            rx={1.0}
            className="floor"
          />,
        );
      }
      // Dome
      if (lvl === 4) {
        const [cx, cy] = cellCenter(r, c);
        cells.push(<circle key={`d-${r}-${c}`} cx={cx} cy={cy} r={CELL * 0.28} className="dome" />);
      } else if (lvl > 0) {
        // Show numeric level in the bottom-right corner.
        cells.push(
          <text
            key={`n-${r}-${c}`}
            x={x + CELL - 1.6}
            y={y + CELL - 1.6}
            className="level-num"
          >
            {lvl}
          </text>,
        );
      }
    }
  }

  const renderBuilder = (side: "p0" | "p1", b: { row: number; col: number }, key: string) => {
    const [cx, cy] = cellCenter(b.row, b.col);
    return <circle key={key} cx={cx} cy={cy} r={CELL * 0.18} className={cn("builder", side)} />;
  };

  return (
    <div className={cn("santorini-board", className)} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
        {cells}
        {renderBuilder("p0", b0[0], "b00")}
        {renderBuilder("p0", b0[1], "b01")}
        {renderBuilder("p1", b1[0], "b10")}
        {renderBuilder("p1", b1[1], "b11")}
      </svg>
    </div>
  );
}
