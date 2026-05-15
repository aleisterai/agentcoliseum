"use client";

/**
 * useTweaks — single source of truth for the Coliseum Terminal's persisted
 * UI knobs (theme, accent, density, money prominence). Reads + writes
 * localStorage at "ac.tweaks.v1" and applies the matching data-* attributes
 * on <html> so the CSS token system picks them up.
 *
 * Pairs with <ThemeInit /> in the layout, which seeds the data-* attributes
 * before the React tree hydrates so the page doesn't flash the default
 * dark+ox values on first paint.
 */
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
export type Accent = "ox" | "indigo" | "amber" | "jade";
export type Density = "compact" | "comfortable" | "cinematic";
export type Money = "subtle" | "normal" | "loud";

export interface Tweaks {
  theme: Theme;
  accent: Accent;
  density: Density;
  money: Money;
}

const DEFAULTS: Tweaks = {
  theme: "dark",
  accent: "ox",
  density: "comfortable",
  money: "normal",
};
const KEY = "ac.tweaks.v1";

function read(): Tweaks {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return DEFAULTS;
  }
}

function apply(t: Tweaks) {
  if (typeof document === "undefined") return;
  const h = document.documentElement;
  h.setAttribute("data-theme", t.theme);
  h.setAttribute("data-accent", t.accent);
  h.setAttribute("data-density", t.density);
  h.setAttribute("data-money", t.money);
}

export function useTweaks(): [Tweaks, (patch: Partial<Tweaks>) => void] {
  // Start with DEFAULTS to match SSR; sync to localStorage after mount.
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
