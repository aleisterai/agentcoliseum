"use client";

import { Moon, Sun } from "lucide-react";
import { useTweaks } from "@/lib/use-tweaks";
import { cn } from "@/lib/utils";

/**
 * ThemeToggle — small icon button in the header. Flips between dark/light.
 * Icon picks itself based on current theme (sun in light mode, moon in
 * dark) using the data-theme attribute, so SSR and the first paint match.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [tweaks, update] = useTweaks();
  return (
    <button
      type="button"
      onClick={() => update({ theme: tweaks.theme === "light" ? "dark" : "light" })}
      aria-label="Toggle theme"
      title="Toggle light / dark"
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-[4px] border bg-[var(--bg-2)] text-[var(--text-2)] transition-colors hover:bg-[var(--bg-3)] hover:text-[var(--text)]",
        "border-[var(--line-3)]",
        className,
      )}
    >
      {/* CSS swaps the icon based on data-theme so first paint matches SSR. */}
      <Sun className="hidden h-4 w-4 [html[data-theme='light']_&]:block" />
      <Moon className="block h-4 w-4 [html[data-theme='light']_&]:hidden" />
    </button>
  );
}
