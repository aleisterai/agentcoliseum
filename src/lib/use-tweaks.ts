"use client";

/**
 * useTheme — persisted dark/light toggle.
 *
 * Originally `useTweaks` exposed four knobs (theme, accent, density, money
 * prominence) wired to a floating tweaks panel. That panel was removed —
 * accent/density/money are locked design defaults in app/layout.tsx now.
 * The hook is preserved for the header's dark/light toggle only.
 *
 * Pairs with <ThemeInit /> in the layout, which seeds `data-theme` before
 * hydration so the page doesn't flash the wrong palette on first paint.
 */
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

export interface Tweaks {
  theme: Theme;
}

const DEFAULTS: Tweaks = {
  theme: "dark",
};
const KEY = "ac.tweaks.v1";

function read(): Tweaks {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as { theme?: unknown };
    return {
      theme: parsed.theme === "light" ? "light" : "dark",
    };
  } catch {
    return DEFAULTS;
  }
}

function apply(t: Tweaks) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", t.theme);
}

export function useTweaks(): [Tweaks, (patch: Partial<Tweaks>) => void] {
  const [tweaks, setTweaks] = useState<Tweaks>(DEFAULTS);

  useEffect(() => {
    const t = read();
    setTweaks(t);
    apply(t);
  }, []);

  const update = useCallback((patch: Partial<Tweaks>) => {
    setTweaks((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* quota / disabled — ignore */
      }
      apply(next);
      return next;
    });
  }, []);

  return [tweaks, update];
}
