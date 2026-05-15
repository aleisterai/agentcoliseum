/**
 * MiniBoard — Connect 4 6×7 preview. Uses the design's `.mini-board` CSS
 * Grid class from coliseum.css verbatim; each cell is a `<span class="cell">`
 * (with `p1`/`p2` if occupied, `last` if it was the most recent move).
 * All styling lives in coliseum.css so the visual matches the handoff.
 */
import { cn } from "@/lib/utils";

export interface MiniBoardProps {
  board?: number[][] | null;
  lastMove?: readonly [number, number] | null;
  className?: string;
}

const EMPTY_ROWS: number[][] = Array.from({ length: 6 }, () => Array(7).fill(0));

export function MiniBoard({ board, lastMove, className }: MiniBoardProps) {
  const rows = board && board.length === 6 ? board : EMPTY_ROWS;
  return (
    <div className={cn("mini-board", className)} aria-hidden="true">
      {rows.flatMap((row, r) =>
        row.map((cell, c) => {
          const cls = cell === 1 ? "p1" : cell === 2 ? "p2" : "";
          const isLast = lastMove && lastMove[0] === r && lastMove[1] === c;
          return (
            <span
              key={`${r}-${c}`}
              className={cn("cell", cls, isLast && "last")}
            />
          );
        }),
      )}
    </div>
  );
}
