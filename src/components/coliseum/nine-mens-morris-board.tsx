/**
 * NineMensMorrisBoard — SVG renderer for the 24-point board.
 *
 * Three concentric squares with cross-connections at the four cardinal
 * midpoints. Pieces sit on the intersections. Last-played piece gets a
 * highlighted outline.
 *
 * The 24 points map to (x, y) coordinates in a 100×100 viewport:
 *
 *     outer ring: at 10/50/90 on each axis
 *     middle ring: at 25/50/75
 *     inner ring: at 40/50/60
 *
 * Lines on the board:
 *   - 4 sides of each ring (3 rings × 4 sides = 12)
 *   - 4 cross-connectors at the cardinal midpoints (top/bottom/left/right)
 */
import { cn } from "@/lib/utils";

export interface NMMBoardProps {
  points?: Array<"" | "0" | "1"> | null;
  lastMove?: { from: number | null; to: number } | null;
  className?: string;
}

const EMPTY: Array<"" | "0" | "1"> = Array<"" | "0" | "1">(24).fill("");

// Precomputed (x, y) coordinates for each of the 24 points.
const COORDS: ReadonlyArray<readonly [number, number]> = [
  // Outer ring (top, left-to-right then middle row then bottom)
  [10, 10], [50, 10], [90, 10],     // 0, 1, 2
  [25, 25], [50, 25], [75, 25],     // 3, 4, 5
  [40, 40], [50, 40], [60, 40],     // 6, 7, 8
  [10, 50], [25, 50], [40, 50],     // 9, 10, 11
  [60, 50], [75, 50], [90, 50],     // 12, 13, 14
  [40, 60], [50, 60], [60, 60],     // 15, 16, 17
  [25, 75], [50, 75], [75, 75],     // 18, 19, 20
  [10, 90], [50, 90], [90, 90],     // 21, 22, 23
];

// Lines between points (drawn as straight segments).
const LINES: ReadonlyArray<readonly [number, number]> = [
  // Outer ring
  [0, 2], [2, 23], [23, 21], [21, 0],
  // Middle ring
  [3, 5], [5, 20], [20, 18], [18, 3],
  // Inner ring
  [6, 8], [8, 17], [17, 15], [15, 6],
  // Cardinal cross-connectors
  [1, 4], [4, 7], // top
  [16, 19], [19, 22], // bottom
  [9, 10], [10, 11], // left
  [12, 13], [13, 14], // right
];

export function NineMensMorrisBoard({ points, lastMove, className }: NMMBoardProps) {
  const pts = points && points.length === 24 ? points : EMPTY;
  return (
    <div className={cn("nmm-board", className)} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
        {LINES.map(([a, b], i) => (
          <line
            key={`l${i}`}
            x1={COORDS[a][0]}
            y1={COORDS[a][1]}
            x2={COORDS[b][0]}
            y2={COORDS[b][1]}
            className="line"
          />
        ))}
        {COORDS.map(([x, y], i) => {
          const owner = pts[i];
          const isLast = lastMove?.to === i;
          if (owner === "0" || owner === "1") {
            return (
              <circle
                key={`p${i}`}
                cx={x}
                cy={y}
                r={3.5}
                className={cn("piece", owner === "0" ? "p0" : "p1", isLast && "last")}
              />
            );
          }
          return <circle key={`pt${i}`} cx={x} cy={y} r={1.2} className="point" />;
        })}
      </svg>
    </div>
  );
}
