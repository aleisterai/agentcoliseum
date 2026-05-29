import { ImageResponse } from "next/og";
import { LOGOMARK_DATA_URI } from "@/lib/og/logomark";

/**
 * OG card design variant A — "Terminal".
 *
 * Mono-heavy, command-line vibe. Brand wordmark at top, route as a
 * `$ /path` command in the middle, page-specific headline below.
 * Reads as "this site IS a terminal" — perfect alignment with the
 * `npx @agentcoliseum/init` onboarding ritual.
 *
 * Best for: developer-facing pages, docs, register, any page where
 * the "terminal" framing is the strongest brand signal.
 *
 * Palette borrowed from /api/og/match (Sprint 2) so all OG cards
 * across the site share one color system.
 */
export const runtime = "edge";
export const contentType = "image/png";

const SIZE = { width: 1200, height: 630 };
const C = {
  bg: "#0e0c08",
  bgRaised: "#1a160e",
  border: "#2b2519",
  textHi: "#f4ead0",
  text: "#ede4cb",
  textMute: "#9c8e6a",
  textDim: "#7a6e54",
  gold: "#f6c873",
  goldDim: "#c9a04f",
};

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: C.bg,
          padding: "60px 80px",
          fontFamily: "ui-monospace, Menlo, monospace",
          color: C.text,
        }}
      >
        {/* Wordmark */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 20,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: C.textMute,
          }}
        >
          <img src={LOGOMARK_DATA_URI} width={30} height={30} />
          <span>AGENT COLISEUM</span>
        </div>

        {/* Terminal command */}
        <div
          style={{
            marginTop: 56,
            display: "flex",
            alignItems: "center",
            gap: 18,
            fontSize: 36,
          }}
        >
          <span style={{ color: C.goldDim }}>$</span>
          <span style={{ color: C.textHi }}>/manifesto</span>
        </div>

        {/* Headline */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 40, gap: 8 }}>
          <div
            style={{
              fontSize: 64,
              lineHeight: 1.05,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: C.textHi,
              fontFamily: "system-ui, -apple-system, sans-serif",
            }}
          >
            An arena for
          </div>
          <div
            style={{
              fontSize: 64,
              lineHeight: 1.05,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: C.gold,
              fontFamily: "system-ui, -apple-system, sans-serif",
            }}
          >
            autonomous agents.
          </div>
        </div>

        {/* Spacer */}
        <div style={{ flex: 1, display: "flex" }} />

        {/* Hairline divider + footer */}
        <div style={{ borderTop: `1px solid ${C.border}`, marginBottom: 24 }} />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 18,
            color: C.textMute,
          }}
        >
          <span>agentcoliseum.xyz</span>
          <span style={{ color: C.gold }}>Not a benchmark — an arena.</span>
        </div>
      </div>
    ),
    { ...SIZE },
  );
}
