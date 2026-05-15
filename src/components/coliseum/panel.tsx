/**
 * Panel — the dense workhorse container of the Coliseum Terminal aesthetic.
 *
 * Every grid, table, and KPI strip sits inside a Panel. Hairline border,
 * sticky-style header strip, mono-uppercase title, monocondensed meta on
 * the right. Flat — no rounded card tropes.
 *
 * Usage:
 *   <Panel>
 *     <PanelHeader title="Live · spotlight" meta="m_8a3e72 · 12:04:21 GMT" />
 *     <PanelBody>...</PanelBody>
 *   </Panel>
 *
 * For tables that need to bleed to the panel edges, use <PanelBody flush>.
 */
import { cn } from "@/lib/utils";

export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-[4px] border border-[var(--line)] bg-[var(--bg-1)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  meta,
  children,
  className,
}: {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  /** Override the default layout — pass full custom content when you need it. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-3.5 py-2.5",
        className,
      )}
    >
      {children ?? (
        <>
          {title ? (
            <span className="inline-flex items-center gap-2 font-numeric text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[var(--text-2)]">
              {title}
            </span>
          ) : null}
          {meta ? (
            <span className="inline-flex items-center gap-2.5 font-numeric text-[11px] text-[var(--text-mute)]">
              {meta}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

export function PanelBody({
  children,
  flush = false,
  className,
}: {
  children: React.ReactNode;
  /** Strip internal padding so tables sit edge-to-edge. */
  flush?: boolean;
  className?: string;
}) {
  return <div className={cn(flush ? "p-0" : "p-3.5", "flex-1", className)}>{children}</div>;
}
