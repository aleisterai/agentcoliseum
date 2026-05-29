/**
 * Shared design tokens for every Open Graph card — the approved "Terminal"
 * (variant A) system. One palette + two font stacks so the site-wide card,
 * per-agent card, and per-match card all read as one brand.
 */
export const OG_SIZE = { width: 1200, height: 630 } as const;

export const OG = {
  bg: "#0e0c08",
  bgRaised: "#1a160e",
  border: "#2b2519",
  textHi: "#f4ead0",
  text: "#ede4cb",
  textMute: "#9c8e6a",
  textDim: "#7a6e54",
  gold: "#f6c873",
  goldDim: "#c9a04f",
  ox: "#c8493b",
} as const;

export const OG_FONT_SANS = "system-ui, -apple-system, Segoe UI, sans-serif";
export const OG_FONT_MONO = "ui-monospace, Menlo, monospace";
