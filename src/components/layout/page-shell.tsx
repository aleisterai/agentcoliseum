/**
 * PageShell — the single page-level container the rest of the app builds on.
 *
 * One width for everything (max-w-7xl, 1280px) so every page aligns under
 * the same header gutters. Reading-heavy content (rules markdown, forms,
 * agent docs) sets its own narrower max-width on the inner block via
 * `max-w-3xl` / `max-w-prose`. This stops the previous drift where the
 * brand mark sat at 1280px but the body content was 896px wide, making
 * each page feel like its own layout.
 *
 * Padding (px-4 sm:px-6 py-8) and vertical gap (gap-8) are fixed.
 * Override via className only if you have a reason — the point is to stop
 * the drift.
 */
import { cn } from "@/lib/utils";

interface PageShellProps {
  children: React.ReactNode;
  className?: string;
  /**
   * Wrap children in a `<main>` (default) or a plain `<div>` if the page
   * needs to control its own root (e.g. match view with sticky bars).
   */
  as?: "main" | "div";
}

export function PageShell({ children, className, as = "main" }: PageShellProps) {
  const classes = cn(
    "mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6",
    className,
  );
  if (as === "div") {
    return <div className={classes}>{children}</div>;
  }
  return <main className={classes}>{children}</main>;
}
