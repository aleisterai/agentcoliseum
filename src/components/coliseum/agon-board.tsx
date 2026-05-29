/**
 * AgonBoard — 91-hex "hexagon of hexagons" renderer for Agon.
 *
 * Cells come from the engine's canonical AXIAL layout (so board[i] maps to the
 * right hex). Player 0 = light, player 1 = oxblood (classic light-vs-red; never
 * gold — gold is money in the design system). Queens are larger with a ring;
 * Guards are smaller discs. The centre is marked, the last move's destination
 * ringed, and any flanked cell flagged. Theme-aware via CSS variables.
 */
import { AXIAL } from "@/lib/game/games/agon/game";
import { cn } from "@/lib/utils";

type Cell = "" | "0Q" | "0G" | "1Q" | "1G";

export interface AgonBoardProps {
  board?: Cell[] | null;
  lastMove?: { from?: number; to?: number; flanked?: number[] } | null;
  className?: string;
}

const N = 91;
const EMPTY: Cell[] = Array<Cell>(N).fill("");
const SIZE = 12; // hex "radius" in px
const SQRT3 = 1.7320508075688772;

// Pointy-top axial → pixel.
const PXY = AXIAL.map(({ q, r }) => ({
  x: SIZE * SQRT3 * (q + r / 2),
  y: SIZE * 1.5 * r,
}));
const xs = PXY.map((p) => p.x);
const ys = PXY.map((p) => p.y);
const PAD = SIZE + 4;
const MINX = Math.min(...xs);
const MINY = Math.min(...ys);
const W = Math.max(...xs) - MINX + PAD * 2;
const H = Math.max(...ys) - MINY + PAD * 2;
const cx = (i: number) => PXY[i].x - MINX + PAD;
const cy = (i: number) => PXY[i].y - MINY + PAD;

/** Pointy-top hexagon polygon points around (x,y). */
function hexPoints(x: number, y: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 6; k++) {
    const ang = (Math.PI / 180) * (60 * k - 90);
    pts.push(`${(x + SIZE * Math.cos(ang)).toFixed(2)},${(y + SIZE * Math.sin(ang)).toFixed(2)}`);
  }
  return pts.join(" ");
}

export function AgonBoard({ board, lastMove, className }: AgonBoardProps) {
  const cells = board && board.length === N ? board : EMPTY;
  const lastTo = typeof lastMove?.to === "number" ? lastMove.to : null;
  const lastFrom = typeof lastMove?.from === "number" ? lastMove.from : null;
  const flanked = new Set(lastMove?.flanked ?? []);

  return (
    <svg
      className={cn(className)}
      viewBox={`0 0 ${W.toFixed(1)} ${H.toFixed(1)}`}
      role="img"
      aria-label="Agon board"
      style={{
        width: "100%",
        height: "auto",
        background: "var(--bg-2)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        display: "block",
      }}
    >
      {/* Hex cells */}
      {cells.map((_, i) => (
        <polygon
          key={`h${i}`}
          points={hexPoints(cx(i), cy(i))}
          fill={i === 0 ? "color-mix(in oklab, var(--accent) 12%, var(--bg-1))" : "var(--bg-1)"}
          stroke="var(--line)"
          strokeWidth={1}
        />
      ))}
      {/* Pieces + markers */}
      {cells.map((cell, i) => {
        const owner = cell === "" ? null : cell[0];
        const isQueen = cell.endsWith("Q");
        const fill = owner === "0" ? "var(--text-1)" : owner === "1" ? "var(--ox-bright)" : "none";
        return (
          <g key={`p${i}`}>
            {lastFrom === i && cell === "" ? (
              <circle
                cx={cx(i)}
                cy={cy(i)}
                r={4}
                fill="none"
                stroke="color-mix(in oklab, var(--accent) 45%, transparent)"
                strokeWidth={1.5}
                strokeDasharray="2 2"
              />
            ) : null}
            {/* Capture/flank flash on the now-vacated cell (oxblood = destructive). */}
            {flanked.has(i) ? (
              <circle
                cx={cx(i)}
                cy={cy(i)}
                r={SIZE * 0.8}
                fill="none"
                stroke="var(--ox-bright)"
                strokeWidth={2}
                strokeDasharray="3 2"
              />
            ) : null}
            {owner ? (
              <circle
                cx={cx(i)}
                cy={cy(i)}
                r={isQueen ? SIZE * 0.62 : SIZE * 0.44}
                fill={fill}
                stroke={
                  isQueen
                    ? "color-mix(in oklab, var(--accent) 85%, transparent)"
                    : owner === "0"
                      ? "var(--line)"
                      : "transparent"
                }
                strokeWidth={isQueen ? 2 : 1}
              />
            ) : null}
            {lastTo === i ? (
              <polygon
                points={hexPoints(cx(i), cy(i))}
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
