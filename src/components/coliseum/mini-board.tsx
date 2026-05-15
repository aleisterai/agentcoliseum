/**
 * MiniBoard — Connect 4 6×7 preview tile used in spotlight, multi-view,
 * and the games catalog. Renders the pieces with the Coliseum look:
 * oxblood for player 1, gold for player 2, soft inset wells for empties.
 *
 * Accepts either a board state (6×7 number[][] with 0/1/2) or nothing
 * (renders an empty board).
 */
import { cn } from "@/lib/utils";

export interface MiniBoardProps {
  board?: number[][] | null;
  /** Optional [row, col] of the most recent piece — gets an outline. */
  lastMove?: readonly [number, number] | null;
  className?: string;
}

const EMPTY_ROWS: number[][] = Array.from({ length: 6 }, () => Array(7).fill(0));

export function MiniBoard({ board, lastMove, className }: MiniBoardProps) {
  const rows = board && board.length === 6 ? board : EMPTY_ROWS;
  return (
    <div
      className={cn(
        "mini-board relative grid aspect-[7/6] gap-[4%] overflow-hidden rounded-[4px] border border-[var(--line)] p-[6%]",
        className,
      )}
      style={{
        gridTemplateColumns: "repeat(7, 1fr)",
        gridTemplateRows: "repeat(6, 1fr)",
        background:
          "radial-gradient(circle at 30% 30%, color-mix(in oklab, var(--ox-soft) 50%, transparent) 0%, transparent 70%), linear-gradient(180deg, var(--bg-2), var(--bg-1))",
      }}
      aria-hidden="true"
    >
      {rows.flatMap((row, r) =>
        row.map((cell, c) => {
          const isP1 = cell === 1;
          const isP2 = cell === 2;
          const isLast = lastMove && lastMove[0] === r && lastMove[1] === c;
          return (
            <span
              key={`${r}-${c}`}
              className={cn("rounded-full", isLast && "outline outline-[1.5px] outline-offset-1 outline-[var(--text)]")}
              style={
                isP1
                  ? {
                      background: "var(--ox-bright)",
                      boxShadow:
                        "inset 0 -2px 0 rgba(0,0,0,0.3), 0 0 8px color-mix(in oklab, var(--ox) 40%, transparent)",
                    }
                  : isP2
                    ? {
                        background: "var(--gold)",
                        boxShadow:
                          "inset 0 -2px 0 rgba(0,0,0,0.3), 0 0 8px color-mix(in oklab, var(--gold) 40%, transparent)",
                      }
                    : {
                        background: "color-mix(in oklab, var(--bg) 70%, var(--line-2))",
                        boxShadow: "inset 0 1px 2px rgba(0,0,0,0.5)",
                      }
              }
            />
          );
        }),
      )}
    </div>
  );
}
