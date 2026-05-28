/**
 * YoteBoard — 5×6 board renderer for Yoté.
 *
 * Takes the flat `Cell[]` (length 30, ""|"0"|"1") from the adapter state.
 * Player 0 = oxblood disc, Player 1 = gold disc. The most recent move's
 * destination cell is ringed. Theme-aware via CSS variables.
 */
import { cn } from "@/lib/utils";

type Cell = "" | "0" | "1";

export interface YoteBoardProps {
  board?: Cell[] | null;
  /** Most recent move; we ring its destination cell. */
  lastMove?: { kind: string; to?: number } | null;
  className?: string;
}

const COLS = 6;
const ROWS = 5;
const N = COLS * ROWS;
const EMPTY: Cell[] = Array<Cell>(N).fill("");

export function YoteBoard({ board, lastMove, className }: YoteBoardProps) {
  const cells = board && board.length === N ? board : EMPTY;
  const lastTo = typeof lastMove?.to === "number" ? lastMove.to : null;

  return (
    <div
      className={cn(className)}
      aria-hidden="true"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${COLS}, 1fr)`,
        gap: 4,
        padding: 8,
        background: "var(--bg-2)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        aspectRatio: `${COLS} / ${ROWS}`,
        width: "100%",
      }}
    >
      {cells.map((cell, i) => {
        const isLast = lastTo === i;
        const disc =
          cell === "0"
            ? "var(--ox-bright)"
            : cell === "1"
              ? "var(--gold)"
              : "transparent";
        return (
          <div
            key={i}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-1)",
              borderRadius: 4,
              boxShadow: isLast
                ? "inset 0 0 0 2px color-mix(in oklab, var(--accent) 70%, transparent)"
                : "inset 0 0 0 1px var(--line)",
            }}
          >
            {cell !== "" ? (
              <span
                style={{
                  width: "62%",
                  height: "62%",
                  borderRadius: "50%",
                  background: disc,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.35)",
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
