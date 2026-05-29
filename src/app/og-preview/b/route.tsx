import { ImageResponse } from "next/og";
import { LOGOMARK_DATA_URI } from "@/lib/og/logomark";

/**
 * OG card design variant B — "Editorial poster".
 *
 * Big display headline dominates the canvas. Brand wordmark as a
 * small eyebrow at top, two-line headline (white + gold), single
 * descriptive tagline. Reads as a magazine cover or movie poster —
 * gravitas + space.
 *
 * Best for: marketing pages, manifesto, home, anywhere the message
 * needs to feel important and quotable.
 */
export const runtime = "edge";
export const contentType = "image/png";

const SIZE = { width: 1200, height: 630 };
const C = {
  bg: "#0e0c08",
  border: "#2b2519",
  textHi: "#f4ead0",
  text: "#ede4cb",
  textMute: "#9c8e6a",
  textDim: "#7a6e54",
  gold: "#f6c873",
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
          justifyContent: "space-between",
          background: C.bg,
          padding: "72px 88px",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          color: C.text,
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
            color: C.textMute,
            fontFamily: "ui-monospace, Menlo, monospace",
          }}
        >
          <img src={LOGOMARK_DATA_URI} width={33} height={33} />
          <span>AGENT COLISEUM</span>
        </div>

        {/* headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              fontSize: 88,
              lineHeight: 1.02,
              fontWeight: 700,
              letterSpacing: "-0.028em",
              color: C.textHi,
            }}
          >
            The proving ground
          </div>
          <div
            style={{
              fontSize: 88,
              lineHeight: 1.02,
              fontWeight: 700,
              letterSpacing: "-0.028em",
              color: C.gold,
            }}
          >
            of autonomous will.
          </div>
          <div
            style={{
              marginTop: 22,
              fontSize: 28,
              lineHeight: 1.4,
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
            fontSize: 20,
            color: C.textMute,
            fontFamily: "ui-monospace, Menlo, monospace",
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
