"use client";

import { useState } from "react";
import { Settings2, X } from "lucide-react";
import { useTweaks, type Accent, type Density, type Money, type Theme } from "@/lib/use-tweaks";
import { cn } from "@/lib/utils";

/**
 * TweaksPanel — floating bottom-right panel that exposes the four global
 * UI knobs: theme, accent, density, money prominence. Persists via the
 * shared useTweaks hook.
 *
 * Closed by default; toggled by the trigger button (gear icon).
 */
export function TweaksPanel() {
  const [tweaks, update] = useTweaks();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Open tweaks"
        title="Tweaks"
        className={cn(
          "fixed bottom-4 right-4 z-[70] inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--line-3)] bg-[var(--bg-1)] text-[var(--text-2)] shadow-lg transition-colors hover:bg-[var(--bg-2)] hover:text-[var(--text)]",
          open && "hidden",
        )}
      >
        <Settings2 className="h-4 w-4" />
      </button>

      {open ? (
        <aside
          className="fixed bottom-4 right-4 z-[80] flex w-[260px] max-w-[calc(100vw-32px)] flex-col rounded-[6px] border border-[var(--line-3)] bg-[var(--bg-1)] text-xs shadow-[0_12px_40px_rgba(0,0,0,0.5)]"
        >
          <header className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2.5">
            <span className="font-numeric text-[10px] font-semibold uppercase tracking-[0.18em]">
              Tweaks
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close tweaks"
              className="-mr-1 inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-mute)] hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="flex flex-col gap-3.5 p-3">
            <Row label="Theme">
              <Seg<Theme>
                value={tweaks.theme}
                onChange={(v) => update({ theme: v })}
                options={[
                  { v: "dark", label: "◐ Dark" },
                  { v: "light", label: "☀ Light" },
                ]}
              />
            </Row>
            <Row label="Accent">
              <Swatches
                value={tweaks.accent}
                onChange={(v) => update({ accent: v })}
                options={[
                  { v: "ox", color: "oklch(0.58 0.21 22)" },
                  { v: "indigo", color: "oklch(0.62 0.17 262)" },
                  { v: "amber", color: "oklch(0.72 0.16 60)" },
                  { v: "jade", color: "#B6F500" },
                ]}
              />
            </Row>
            <Row label="Density">
              <Seg<Density>
                value={tweaks.density}
                onChange={(v) => update({ density: v })}
                options={[
                  { v: "compact", label: "Compact" },
                  { v: "comfortable", label: "Comfy" },
                  { v: "cinematic", label: "Cinema" },
                ]}
              />
            </Row>
            <Row label="Money prominence">
              <Seg<Money>
                value={tweaks.money}
                onChange={(v) => update({ money: v })}
                options={[
                  { v: "subtle", label: "Subtle" },
                  { v: "normal", label: "Normal" },
                  { v: "loud", label: "Loud" },
                ]}
              />
            </Row>
          </div>
        </aside>
      ) : null}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 font-numeric text-[10px] uppercase tracking-[0.10em] text-[var(--text-mute)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ v: T; label: string }>;
}) {
  return (
    <div className="flex overflow-hidden rounded-[4px] border border-[var(--line-3)]">
      {options.map((o, i) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            "flex-1 px-2 py-1.5 font-numeric text-[11px] uppercase tracking-[0.06em] transition-colors",
            i !== options.length - 1 && "border-r border-[var(--line-3)]",
            value === o.v
              ? "bg-[var(--bg-3)] text-[var(--text)]"
              : "bg-transparent text-[var(--text-mute)] hover:text-[var(--text)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Swatches<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ v: T; color: string }>;
}) {
  return (
    <div className="flex gap-1.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          aria-label={`Accent: ${o.v}`}
          onClick={() => onChange(o.v)}
          className={cn(
            "h-7 flex-1 cursor-pointer rounded-[3px] border border-[var(--line-3)] transition-shadow",
            value === o.v && "outline outline-2 outline-offset-1 outline-[var(--text)]",
          )}
          style={{ background: o.color }}
        />
      ))}
    </div>
  );
}

export type { Accent };
