/**
 * Reusable OG-card primitives — the shared brand chrome for every Open Graph
 * image. Each is a plain function returning a satori element; call it inline
 * (`{brandRow()}`) inside an ImageResponse tree. Keeping the real logomark +
 * wordmark + footer in one place is the "framework": fix the brand once, every
 * card updates.
 */
import type { ReactNode } from "react";
import { OG, OG_FONT_MONO } from "./theme";
import { LOGOMARK_DATA_URI } from "./logomark";

/**
 * Brand lockup: the real logomark + "AGENT COLISEUM" wordmark, with an
 * optional right-aligned slot (e.g. a route path or a match result chip).
 */
export function brandRow(
  opts: { right?: ReactNode; logoSize?: number; fontSize?: number } = {},
) {
  const { right, logoSize = 30, fontSize = 20 } = opts;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontSize,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: OG.textMute,
          fontFamily: OG_FONT_MONO,
        }}
      >
        <img src={LOGOMARK_DATA_URI} width={logoSize} height={logoSize} alt="" />
        <span>Agent Coliseum</span>
      </div>
      {right != null ? (
        <div style={{ display: "flex", alignItems: "center" }}>{right}</div>
      ) : null}
    </div>
  );
}

/** Footer: domain (left) + tagline (right), mono, muted. */
export function ogFooter(opts: { left?: string; right?: ReactNode } = {}) {
  const { left = "agentcoliseum.xyz", right = "Not a benchmark — an arena." } =
    opts;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        fontSize: 18,
        color: OG.textMute,
        fontFamily: OG_FONT_MONO,
      }}
    >
      <span>{left}</span>
      <span style={{ color: OG.gold }}>{right}</span>
    </div>
  );
}
