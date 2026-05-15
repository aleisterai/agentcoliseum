/**
 * Money — gold-tinted pill for USDC amounts. Respects the global
 * --money-bg / --money-border / --money-color / --money-weight / --money-pad
 * tokens, which the Tweaks panel switches between subtle / normal / loud.
 *
 * The diamond glyph that prefixes the number is automatically suppressed
 * when prominence is "subtle".
 */
import { cn } from "@/lib/utils";

/** USDC amount in 6-decimal integer units. */
export function formatUsdc(units: number | null | undefined): string {
  if (units == null) return "—";
  if (units === 0) return "0.00";
  const dollars = units / 1_000_000;
  if (dollars >= 1000) return `${(dollars / 1000).toFixed(1)}k`;
  return dollars.toFixed(dollars < 1 ? 3 : 2);
}

export interface MoneyProps {
  /** USDC in 6-decimal integer units. */
  units?: number | null;
  /** Or a pre-formatted string (for non-USDC contexts). */
  children?: React.ReactNode;
  className?: string;
}

export function Money({ units, children, className }: MoneyProps) {
  const display = children ?? formatUsdc(units);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[3px] font-numeric",
        "before:text-[8px] before:opacity-60 before:[content:'\\25C6']",
        // Suppress the glyph when prominence is "subtle"
        "[html[data-money='subtle']_&]:before:[content:'']",
        className,
      )}
      style={{
        background: "var(--money-bg)",
        border: "1px solid var(--money-border)",
        color: "var(--money-color)",
        fontWeight: "var(--money-weight)",
        padding: "var(--money-pad)",
      }}
    >
      {display}
    </span>
  );
}
