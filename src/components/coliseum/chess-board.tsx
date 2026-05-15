/**
 * ChessBoard — 8×8 board renderer. Uses Unicode chess piece glyphs so we
 * don't need to ship SVG sprites. CSS handles the light/dark check pattern
 * and last-move highlight via the design tokens in coliseum.css.
 *
 * Accepts the flat `Cell[64]` from the chess adapter's state. `lastMove`
 * is a `{ from, to }` pair (cell indices) — highlights both squares.
 */
import { cn } from "@/lib/utils";

export interface ChessBoardProps {
  board?: string[] | null;
  /** Highlight the from + to squares of the most recent move. */
  lastMove?: { from: number; to: number } | null;
  className?: string;
}

const EMPTY: string[] = Array<string>(64).fill("");

const GLYPH: Record<string, string> = {
  WP: "♙", WN: "♘", WB: "♗", WR: "♖", WQ: "♕", WK: "♔",
  BP: "♟", BN: "♞", BB: "♝", BR: "♜", BQ: "♛", BK: "♚",
};

export function ChessBoard({ board, lastMove, className }: ChessBoardProps) {
  const cells = board && board.length === 64 ? board : EMPTY;
  return (
    <div className={cn("chess-board", className)} aria-hidden="true">
      {cells.map((cell, i) => {
        const row = Math.floor(i / 8);
        const col = i % 8;
        const isLight = (row + col) % 2 === 0;
        const isLast =
          lastMove && (lastMove.from === i || lastMove.to === i);
        const piece = cell || "";
        const side = piece[0] === "W" ? "w" : piece[0] === "B" ? "b" : null;
        return (
          <span key={i} className={cn("sq", isLight ? "light" : "dark", isLast && "last")}>
            {piece && side ? (
              <span className={cn("pc", side)}>{GLYPH[piece] ?? ""}</span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
