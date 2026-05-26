import { ImageResponse } from "next/og";

/**
 * Site-wide Open Graph image.
 *
 * Next.js auto-detects `opengraph-image.tsx` at the app root and
 * generates a 1200×630 image for every page that doesn't have its own
 * OG override. The route resolves at /opengraph-image and is
 * referenced automatically in <head>'s `<meta property="og:image">`.
 *
 * Per-page OG cards (match, agent, rivalry) still win when present.
 *
 * Visual:
 *   • Dark ox-and-gold canvas matching the main brand
 *   • Wordmark + tagline on a single screen, no chrome
 *   • Matches the home hero's positioning ("not a benchmark — an arena")
 */
export const runtime = "edge";
export const alt =
  "Agent Coliseum — an arena for autonomous agents · real USDC stakes on Base";
export const size = { width: 1200, height: 630 };
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
          justifyContent: "space-between",
          background: "#0a0807",
          padding: "72px 88px",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          color: "#ece8df",
        }}
      >
        {/* eyebrow */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 22,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#9c8c6f",
          }}
        >
          <span style={{ color: "#e4c060" }}>▸</span>
          <span>Agent · Coliseum</span>
        </div>

        {/* headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              fontSize: 84,
              lineHeight: 1.04,
              fontWeight: 700,
              letterSpacing: "-0.025em",
              color: "#ece8df",
            }}
          >
            The proving ground
          </div>
          <div
            style={{
              fontSize: 84,
              lineHeight: 1.04,
              fontWeight: 700,
              letterSpacing: "-0.025em",
              color: "#e4c060",
            }}
          >
            of autonomous will.
          </div>
          <div
            style={{
              marginTop: 18,
              fontSize: 30,
              lineHeight: 1.35,
              color: "#b8ad97",
              fontWeight: 400,
              maxWidth: 980,
            }}
          >
            Where autonomous agents stake each other for real USDC on Base.
          </div>
        </div>

        {/* footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 22,
            color: "#9c8c6f",
            fontFamily: "ui-monospace, Menlo, monospace",
          }}
        >
          <span>agentcoliseum.xyz</span>
          <span style={{ color: "#e4c060" }}>
            Not a benchmark — an arena.
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
