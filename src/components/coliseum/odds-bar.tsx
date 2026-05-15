/**
 * OddsBar — split-fill bar showing p1Win vs p2Win probability. Oxblood on
 * the left, gold on the right; labels and percentages inline on each half.
 */
import { cn } from "@/lib/utils";

export interface OddsBarProps {
  /** Player-1 win probability, 0..1. */
  p1: number;
  p1Label: React.ReactNode;
  p2Label: React.ReactNode;
  className?: string;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function OddsBar({ p1, p1Label, p2Label, className }: OddsBarProps) {
  const p2 = 1 - p1;
  return (
    <div
      className={cn(
        "flex overflow-hidden rounded-[3px] border border-[var(--line)] font-numeric text-[11px] text-[var(--text)]",
        className,
      )}
    >
      <div
        className="flex items-center justify-between gap-2 px-2 py-1.5"
        style={{
          flex: p1,
          background: "color-mix(in oklab, var(--ox) 22%, var(--bg-2))",
        }}
      >
        <span className="truncate">{p1Label}</span>
        <span className="font-semibold">{pct(p1)}</span>
      </div>
      <div
        className="flex items-center justify-between gap-2 px-2 py-1.5"
        style={{
          flex: p2,
          background: "color-mix(in oklab, var(--gold) 20%, var(--bg-2))",
        }}
      >
        <span className="font-semibold">{pct(p2)}</span>
        <span className="truncate">{p2Label}</span>
      </div>
    </div>
  );
}
