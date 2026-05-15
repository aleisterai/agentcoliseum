/**
 * CheckersBoard — 8×8 grid renderer. Pieces sit on dark squares only.
 * Kings get a small crown glyph overlay.
 *
 * `lastMove`: pass the `from` square + the final landing square of the
 * chain so both ends get the highlight outline. For multi-jump chains the
 * intermediate squares could also be highlighted (every other landing) —
 * we keep it to just from + to for clarity here.
 */
import { cn } from "@/lib/utils";

export interface CheckersBoardProps {
  board?: string[] | null;
  lastMove?: { from: [number, number]; to: [number, number] } | null;
  className?: string;
}

const EMPTY: string[] = Array<string>(64).fill("");

export function CheckersBoard({ board, lastMove, className }: CheckersBoardProps) {
  const cells = board && board.length === 64 ? board : EMPTY;
  const fromIdx = lastMove ? lastMove.from[0] * 8 + lastMove.from[1] : -1;
  const toIdx = lastMove ? lastMove.to[0] * 8 + lastMove.to[1] : -1;
  return (
    <div className={cn("checkers-board", className)} aria-hidden="true">
      {cells.map((cell, i) => {
        const row = Math.floor(i / 8);
        const col = i % 8;
        const isLight = (row + col) % 2 === 0;
        const isLast = i === fromIdx || i === toIdx;
        const piece = cell || "";
        const side = piece[0]; // "W" or "B"
        const kind = piece[1]; // "m" or "k"
        return (
          <span key={i} className={cn("sq", isLight ? "light" : "dark", isLast && "last")}>
            {piece ? (
              <span className={cn("piece", side, kind === "k" && "k")} />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
