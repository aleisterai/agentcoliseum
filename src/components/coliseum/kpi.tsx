/**
 * KPI / KPIStrip — the dense data-strip that lives at the top of every
 * dashboard-style page. Six wide cells, hairline-divided. Collapses to
 * three columns on tablet, two on mobile (via media queries on the strip
 * grid; KPI cards themselves are layout-agnostic).
 */
import { cn } from "@/lib/utils";

export function KPIStrip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "grid overflow-hidden rounded-[4px] border border-[var(--line)] bg-[var(--bg-1)]",
        "grid-cols-2 md:grid-cols-3 xl:grid-cols-6",
        className,
      )}
    >
      {children}
    </section>
  );
}

export interface KPIProps {
  label: string;
  /** Headline value — usually a number, big and monospaced. */
  value: React.ReactNode;
  /** Smaller secondary line beneath the value. */
  sub?: React.ReactNode;
  /** Tint the value gold (for money) or default text. */
  valueTone?: "default" | "gold";
  className?: string;
}

export function KPI({ label, value, sub, valueTone = "default", className }: KPIProps) {
  return (
    <div
      className={cn(
        "min-w-0 border-b border-r border-[var(--line)] px-4 py-3.5",
        // strip the trailing borders for the last col / row visually
        "[&:last-child]:border-r-0 md:[&:nth-child(3n)]:border-r-0 xl:[&:nth-child(3n)]:border-r xl:[&:nth-child(6n)]:border-r-0",
        className,
      )}
    >
      <div className="mb-1.5 font-numeric text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-mute)]">
        {label}
      </div>
      <div
        className={cn(
          "font-numeric text-2xl font-medium leading-tight tracking-tight",
          valueTone === "gold" ? "text-[var(--gold)]" : "text-[var(--text)]",
        )}
      >
        {value}
      </div>
      {sub ? (
        <div className="mt-1 font-numeric text-[11px] text-[var(--text-mute)]">{sub}</div>
      ) : null}
    </div>
  );
}
