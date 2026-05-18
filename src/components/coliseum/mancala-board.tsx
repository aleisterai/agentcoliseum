/**
 * MancalaBoard — wooden mancala board with two stores at the ends.
 *
 * Layout (P1 at top, P0 at bottom — convention for displaying the seated
 * "player 0" at the bottom of the screen):
 *
 *   ┌─────────┬──[12][11][10][9][8][7]──┬─────────┐
 *   │ P1 STORE│                         │ P0 STORE│
 *   └─────────┴──[0][1][2][3][4][5]─────┴─────────┘
 *
 * The CSS uses `direction: rtl` on P1's row so pit 12 appears left and
 * pit 7 appears right — matching the seed-flow direction (P0 sows
 * counter-clockwise: 0 → 1 → 2 → 3 → 4 → 5 → store-0 → 7 → 8 → … →
 * 12 → 0 → …).
 */
import { cn } from "@/lib/utils";

export interface MancalaBoardProps {
  pits?: number[] | null;
  lastMove?: { pit: number; landed: number } | null;
  className?: string;
}

const EMPTY: number[] = Array<number>(14).fill(0);

export function MancalaBoard({ pits, lastMove, className }: MancalaBoardProps) {
  const p = pits && pits.length === 14 ? pits : EMPTY;

  // P1's row top: pits 7..12. P0's row bottom: pits 0..5.
  const p1Pits = [7, 8, 9, 10, 11, 12];
  const p0Pits = [0, 1, 2, 3, 4, 5];

  return (
    <div className={cn("mancala-board", className)} aria-hidden="true">
      {/* P1 store on the left */}
      <div className="store">
        <span className="seeds">{p[13]}</span>
        <span className="lbl">P1</span>
      </div>

      {/* Two rows of pits */}
      <div className="rows">
        <div className="row-pits p1">
          {p1Pits.map((idx) => (
            <span
              key={idx}
              className={cn(
                "pit",
                p[idx] === 0 && "empty",
                lastMove?.pit === idx && "last",
                lastMove?.landed === idx && "landed",
              )}
            >
              {p[idx]}
            </span>
          ))}
        </div>
        <div className="row-pits p0">
          {p0Pits.map((idx) => (
            <span
              key={idx}
              className={cn(
                "pit",
                p[idx] === 0 && "empty",
                lastMove?.pit === idx && "last",
                lastMove?.landed === idx && "landed",
              )}
            >
              {p[idx]}
            </span>
          ))}
        </div>
      </div>

      {/* P0 store on the right */}
      <div className="store">
        <span className="seeds">{p[6]}</span>
        <span className="lbl">P0</span>
      </div>
    </div>
  );
}
