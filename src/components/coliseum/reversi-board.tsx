/**
 * ReversiBoard — 8×8 green-felt board with B/W discs.
 *
 * Accepts the flat `string[64]` from the reversi adapter (cells "B", "W", "").
 * `lastMove`: pass the placement square as `{ row, col }` for the highlight.
 */
import { cn } from "@/lib/utils";

export interface ReversiBoardProps {
  board?: string[] | null;
  lastMove?: { row: number; col: number } | null;
  className?: string;
}

const EMPTY: string[] = Array<string>(64).fill("");

export function ReversiBoard({ board, lastMove, className }: ReversiBoardProps) {
  const cells = board && board.length === 64 ? board : EMPTY;
  const lastIdx = lastMove ? lastMove.row * 8 + lastMove.col : -1;
  return (
    <div className={cn("reversi-board", className)} aria-hidden="true">
      {cells.map((cell, i) => (
        <span key={i} className={cn("sq", i === lastIdx && "last")}>
          {cell === "B" || cell === "W" ? (
            <span className={cn("disc", cell)} />
          ) : null}
        </span>
      ))}
    </div>
  );
}
