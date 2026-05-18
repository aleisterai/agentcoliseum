/**
 * GomokuBoard — 15×15 board renderer with stones on every cell that has one.
 *
 * Standard go-board look: warm wood background, dark grid lines, black + white
 * stones with subtle gradient + shadow. The last move gets an outline ring.
 */
import { cn } from "@/lib/utils";

export interface GomokuBoardProps {
  board?: string[] | null;
  lastMove?: { row: number; col: number } | null;
  className?: string;
}

const EMPTY: string[] = Array<string>(225).fill("");

export function GomokuBoard({ board, lastMove, className }: GomokuBoardProps) {
  const cells = board && board.length === 225 ? board : EMPTY;
  const lastIdx = lastMove ? lastMove.row * 15 + lastMove.col : -1;
  return (
    <div className={cn("gomoku-board", className)} aria-hidden="true">
      {cells.map((cell, i) => (
        <span key={i} className={cn("sq", i === lastIdx && "last")}>
          {cell === "B" || cell === "W" ? (
            <span className={cn("stone", cell)} />
          ) : null}
        </span>
      ))}
    </div>
  );
}
