/**
 * NimBoard — three columns of circular "stones" stacked from the bottom.
 * The last-touched pile gets stones rendered in the --ox-bright color
 * so you can see which pile was just taken from.
 *
 * Pile sizes can exceed the visible space; we cap the stack height to
 * ~7 stones and add a "+N" overflow indicator above.
 */
import { cn } from "@/lib/utils";

export interface NimBoardProps {
  piles?: number[] | null;
  lastMove?: { pile: number; take: number } | null;
  className?: string;
}

const MAX_VISIBLE = 7;

export function NimBoard({ piles, lastMove, className }: NimBoardProps) {
  const p = piles && piles.length === 3 ? piles : [0, 0, 0];
  return (
    <div className={cn("nim-board", className)} aria-hidden="true">
      {[0, 1, 2].map((idx) => {
        const count = p[idx];
        const overflow = Math.max(0, count - MAX_VISIBLE);
        const visible = Math.min(count, MAX_VISIBLE);
        const isLast = lastMove?.pile === idx;
        return (
          <div key={idx} className={cn("pile", count === 0 && "empty")}>
            {Array.from({ length: visible }).map((_, i) => (
              <span key={i} className={cn("stone", isLast && i < (lastMove?.take ?? 0) && "last")} />
            ))}
            {overflow > 0 ? (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--text-mute)",
                }}
              >
                +{overflow}
              </span>
            ) : null}
            <span className="lbl">
              {idx === 0 ? "A" : idx === 1 ? "B" : "C"} · {count}
            </span>
          </div>
        );
      })}
    </div>
  );
}
