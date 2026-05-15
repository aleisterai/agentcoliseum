/**
 * StatusBadge — single source of truth for game-status pills used in cards,
 * lists, and headers. Two flavors:
 *
 *   "live"        → oxblood pill with a pulsing dot
 *   "coming-soon" → muted outline pill ("wave N")
 *   "final"       → muted outline pill (completed matches)
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Status = "live" | "coming-soon" | "final";

interface StatusBadgeProps {
  status: Status;
  /** Required when status is "coming-soon". Renders as "wave N". */
  wave?: number;
  className?: string;
}

export function StatusBadge({ status, wave, className }: StatusBadgeProps) {
  if (status === "live") {
    return (
      <Badge
        variant="live"
        className={cn(
          "inline-flex items-center gap-1.5 backdrop-blur",
          "font-numeric text-[10px] uppercase tracking-[0.18em]",
          className,
        )}
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-destructive" />
        </span>
        live
      </Badge>
    );
  }
  if (status === "final") {
    return (
      <Badge
        variant="outline"
        className={cn(
          "bg-background/85 backdrop-blur",
          "font-numeric text-[10px] uppercase tracking-[0.18em] text-muted-foreground",
          className,
        )}
      >
        final
      </Badge>
    );
  }
  // coming-soon
  return (
    <Badge
      variant="outline"
      className={cn(
        "bg-background/85 backdrop-blur",
        "font-numeric text-[10px] uppercase tracking-[0.18em] text-muted-foreground",
        className,
      )}
    >
      wave {wave ?? "?"}
    </Badge>
  );
}
