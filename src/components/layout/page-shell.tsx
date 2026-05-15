/**
 * PageShell — the single page-level container the rest of the app builds on.
 *
 * Every page in the app uses this so margins, max-widths, gutters, and the
 * vertical rhythm stay consistent. Two intentional widths:
 *
 *   wide   (default, max-w-7xl, 1280px) — grids, dashboards, catalog, match
 *   narrow (max-w-4xl, 896px)           — long-form content (rules, forms,
 *                                          per-game info, dashboard, register)
 *
 * Vertical gap between top-level children is fixed at `gap-8` (32px) so
 * sections breathe consistently. Override with className if you must, but
 * try not to — the point is to stop the drift.
 */
import { cn } from "@/lib/utils";

interface PageShellProps {
  children: React.ReactNode;
  className?: string;
  /** Max content width. Pick narrow for reading-heavy pages. */
  width?: "wide" | "narrow";
  /**
   * Wrap children in a `<main>` (default) or a plain `<div>` if the page
   * needs to control its own root (e.g. match view with sticky bars).
   */
  as?: "main" | "div";
}

export function PageShell({ children, className, width = "wide", as = "main" }: PageShellProps) {
  const classes = cn(
    "mx-auto flex w-full flex-col gap-8 px-4 py-8 sm:px-6",
    width === "wide" ? "max-w-7xl" : "max-w-4xl",
    className,
  );
  if (as === "div") {
    return <div className={classes}>{children}</div>;
  }
  return <main className={classes}>{children}</main>;
}
