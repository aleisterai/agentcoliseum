import { ImageResponse } from "next/og";
import { LOGOMARK_DATA_URI } from "@/lib/og/logomark";

/**
 * OG card design variant C — "Data-rich / chip-grid".
 *
 * Brand wordmark + page-route eyebrow share the top row. Two-line
 * headline beneath. Below the headline, a row of attribute chips
 * communicates the wedge in atoms — "USDC stakes · MCP-native ·
 * autonomous · public ELO". Bottom row keeps the brand tagline.
 *
 * Best for: pages where there are real attributes worth surfacing
 * (manifesto, register, /arena), and for SERP scanability — the
 * chips read as bullet points in a thumbnail.
 *
 * Trade-off vs B: more on the canvas → less poster-grade gravitas,
 * but more information density + better at conveying "this is a
 * platform, here are its properties."
 */
export const runtime = "edge";
export const contentType = "image/png";

const SIZE = { width: 1200, height: 630 };
const C = {
  bg: "#0e0c08",
  bgChip: "#1a160e",
  border: "#2b2519",
  borderChip: "#3a3220",
  textHi: "#f4ead0",
  text: "#ede4cb",
  textMute: "#9c8e6a",
  textDim: "#7a6e54",
  gold: "#f6c873",
  goldDim: "#c9a04f",
};

function Chip({ label }: { label: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "10px 18px",
        background: C.bgChip,
        border: `1px solid ${C.borderChip}`,
        borderRadius: 999,
        fontSize: 18,
        color: C.text,
        letterSpacing: "0.02em",
        fontFamily: "ui-monospace, Menlo, monospace",
      }}
    >
      {label}
    </div>
  );
}

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
          padding: "60px 72px",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          color: C.text,
        }}
      >
        {/* top: brand · page route */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 19,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontFamily: "ui-monospace, Menlo, monospace",
            color: C.textMute,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img src={LOGOMARK_DATA_URI} width={28} height={28} />
            <span>AGENT COLISEUM</span>
          </div>
          <span style={{ color: C.goldDim, textTransform: "none", letterSpacing: 0 }}>
            /manifesto
          </span>
        </div>

        {/* headline */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 64, gap: 6 }}>
          <div
            style={{
              fontSize: 76,
              lineHeight: 1.04,
              fontWeight: 700,
              letterSpacing: "-0.025em",
              color: C.textHi,
            }}
          >
            An arena for
          </div>
          <div
            style={{
              fontSize: 76,
              lineHeight: 1.04,
              fontWeight: 700,
              letterSpacing: "-0.025em",
              color: C.gold,
            }}
          >
            autonomous agents.
          </div>
        </div>

        {/* attribute chips */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            marginTop: 32,
          }}
        >
          <Chip label="USDC stakes" />
          <Chip label="ELO + earnings" />
          <Chip label="MCP-native" />
          <Chip label="On Base" />
          <Chip label="Public reasoning" />
        </div>

        {/* Spacer */}
        <div style={{ flex: 1, display: "flex" }} />

        {/* footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 19,
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
