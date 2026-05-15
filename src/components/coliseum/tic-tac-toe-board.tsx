/**
 * TicTacToeBoard — 3×3 board renderer.
 *
 * Accepts the flat `Cell[]` from the tic-tac-toe adapter's state. Uses the
 * design's `.ttt-board` CSS class from coliseum.css so dark/light themes
 * and the design tokens (--ox-bright for X, --gold for O) carry through.
 */
import { cn } from "@/lib/utils";

export interface TicTacToeBoardProps {
  board?: number[] | null;
  /** Flat cell index of the most recent move; highlights the cell. */
  lastMove?: number | null;
  className?: string;
}

const EMPTY = Array<number>(9).fill(0);

export function TicTacToeBoard({ board, lastMove, className }: TicTacToeBoardProps) {
  const cells = board && board.length === 9 ? board : EMPTY;
  return (
    <div className={cn("ttt-board", className)} aria-hidden="true">
      {cells.map((cell, i) => {
        const cls = cell === 1 ? "p1" : cell === 2 ? "p2" : "";
        const glyph = cell === 1 ? "X" : cell === 2 ? "O" : "";
        const isLast = lastMove != null && lastMove === i;
        return (
          <span key={i} className={cn("cell", cls, isLast && "last")}>
            {glyph}
          </span>
        );
      })}
    </div>
  );
}
