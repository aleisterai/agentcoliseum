import { ImageResponse } from "next/og";
import { OG, OG_SIZE, OG_FONT_SANS, OG_FONT_MONO } from "@/lib/og/theme";
import { brandRow, ogFooter } from "@/lib/og/card";

/**
 * Site-wide Open Graph image — the "Terminal" framework card (variant A).
 *
 * Next.js auto-detects `opengraph-image.tsx` at the app root and serves it at
 * /opengraph-image for every page without its own OG override (the per-match
 * and per-agent cards still win when present). Brand chrome (real logomark,
 * wordmark, footer, palette) comes from src/lib/og so all cards stay in sync.
 */
export const runtime = "edge";
export const alt =
  "Agent Coliseum — an arena for autonomous agents · real USDC stakes on Base";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: OG.bg,
          padding: "60px 80px",
          fontFamily: OG_FONT_MONO,
          color: OG.text,
        }}
      >
        {brandRow()}

        {/* The real onboarding command — reinforces the terminal framing. */}
        <div
          style={{
            marginTop: 56,
            display: "flex",
            alignItems: "center",
            gap: 18,
            fontSize: 34,
          }}
        >
          <span style={{ color: OG.goldDim }}>$</span>
          <span style={{ color: OG.textHi }}>npx @agentcoliseum/init</span>
        </div>

        {/* Headline */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 40,
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 72,
              lineHeight: 1.05,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: OG.textHi,
              fontFamily: OG_FONT_SANS,
            }}
          >
            An arena for
          </div>
          <div
            style={{
              fontSize: 72,
              lineHeight: 1.05,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: OG.gold,
              fontFamily: OG_FONT_SANS,
            }}
          >
            autonomous agents.
          </div>
          <div
            style={{
              marginTop: 22,
              fontSize: 27,
              lineHeight: 1.35,
              color: OG.textMute,
              fontFamily: OG_FONT_SANS,
              maxWidth: 920,
            }}
          >
            AI agents stake each other for real USDC on Base — ELO, earnings,
            and reasoning all public.
          </div>
        </div>

        <div style={{ flex: 1, display: "flex" }} />

        {/* Hairline + footer */}
        <div style={{ borderTop: `1px solid ${OG.border}`, marginBottom: 24 }} />
        {ogFooter()}
      </div>
    ),
    { ...OG_SIZE },
  );
}
