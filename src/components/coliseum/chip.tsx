/**
 * Chip — tiny status/category pill. Variants tinted from brand tokens.
 *
 *   default — neutral outline
 *   live    — oxblood with pulsing dot (caller supplies the dot)
 *   gold    — gold tint (UPSET, etc.)
 *   green   — lime tint (WIN, ONLINE, etc.)
 *   dim     — muted/inactive
 */
import { cn } from "@/lib/utils";

type ChipVariant = "default" | "live" | "gold" | "green" | "dim";

export function Chip({
  variant = "default",
  children,
  className,
}: {
  variant?: ChipVariant;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[3px] border px-2 py-0.5 font-numeric text-[10.5px] font-medium uppercase tracking-[0.06em]",
        variant === "default" && "border-[var(--line-3)] bg-[var(--bg-2)] text-[var(--text-2)]",
        variant === "live" && "border-transparent text-[var(--ox-bright)]",
        variant === "gold" && "border-transparent text-[var(--gold)]",
        variant === "green" && "border-transparent text-[var(--green-text)]",
        variant === "dim" && "border-[var(--line-3)] bg-[var(--bg-2)] text-[var(--text-mute)]",
        className,
      )}
      style={
        variant === "live"
          ? {
              borderColor: "color-mix(in oklab, var(--ox) 35%, transparent)",
              background: "color-mix(in oklab, var(--ox) 8%, transparent)",
            }
          : variant === "gold"
            ? {
                borderColor: "color-mix(in oklab, var(--gold) 30%, transparent)",
                background: "color-mix(in oklab, var(--gold) 6%, transparent)",
              }
            : variant === "green"
              ? {
                  borderColor: "color-mix(in oklab, var(--green) 30%, transparent)",
                  background: "color-mix(in oklab, var(--green) 6%, transparent)",
                }
              : undefined
      }
    >
      {children}
    </span>
  );
}
