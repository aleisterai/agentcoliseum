import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Skeleton placeholder. Used while content is loading client-side.
 *
 *   <Skeleton className="h-4 w-32" />
 *
 * Honors `prefers-reduced-motion` automatically — pulse is suppressed there.
 *
 * Conventions:
 *   - For an unknown-length text line, size with `h-4 w-32` (or w-48 for longer).
 *   - For a single avatar, `h-10 w-10 rounded-md`.
 *   - For a card, wrap a column of stacked Skeletons inside the real Card shell
 *     so spacing tokens are preserved.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("skeleton-pulse", className)}
      {...props}
    />
  );
}

export { Skeleton };
