/**
 * GET /api/og/agent/[handle]
 *
 * Dynamic 1200×630 OG card for an agent profile. Renders via Next.js's
 * native `next/og` ImageResponse. Used by:
 *   - <meta property="og:image"> on /agents/[handle]
 *   - Twitter card image
 *   - Farcaster Frame thumbnail
 *
 * Constraints (satori under the hood):
 *   - every <div> with multiple children needs explicit display:flex|contents|none
 *   - no remote fonts unless we wire them; stick to system mono + sans
 *   - no unicode glyphs without a font that contains them — keep ASCII
 *     where possible, swap diamond ◆ for "$", chips/dots for plain text
 */
import { ImageResponse } from "next/og";
import { eq, and, gte, sql, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";

export const runtime = "nodejs";

const SIZE = { width: 1200, height: 630 };

const COLORS = {
  bg: "#0e0c08",
  bgPanel: "#13100a",
  border: "#2b2519",
  textHi: "#f4ead0",
  text: "#ede4cb",
  textMute: "#9c8e6a",
  textDim: "#7a6e54",
  gold: "#f6c873",
  green: "#a4d97a",
  red: "#e89090",
} as const;

function avatarInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return displayName.slice(0, 2).toUpperCase();
}

function avatarColors(handle: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) | 0;
  const palettes = [
    { bg: "#2d1f14", fg: "#f6c873" },
    { bg: "#1f2b1a", fg: "#a4d97a" },
    { bg: "#2a1620", fg: "#e89bc4" },
    { bg: "#1a232b", fg: "#79b8ff" },
    { bg: "#2a2017", fg: "#e0b864" },
    { bg: "#1f1a25", fg: "#b89eff" },
  ];
  return palettes[Math.abs(h) % palettes.length];
}

function fmtUsdc(microUsdc: number): string {
  const usdc = microUsdc / 1_000_000;
  if (usdc >= 1_000_000) return `${(usdc / 1_000_000).toFixed(1)}M`;
  if (usdc >= 1_000) return `${(usdc / 1_000).toFixed(1)}k`;
  if (usdc >= 100) return usdc.toFixed(0);
  return usdc.toFixed(2);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  const { handle } = await params;
  const agent = await db.query.agents.findFirst({
    where: eq(agents.handle, handle),
  });

  if (!agent) {
    return new ImageResponse(
      (
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
            background: COLORS.bg,
            color: COLORS.textMute,
            fontSize: 64,
          }}
        >
          @{handle} not found
        </div>
      ),
      SIZE,
    );
  }

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [earnRow] = await db
    .select({
      net: sql<number>`COALESCE(SUM(${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0) - (${matches.potUsdc} / 2)), 0)::bigint`,
    })
    .from(matches)
    .where(
      and(
        eq(matches.status, "completed"),
        eq(matches.winnerAgentId, agent.id),
        gte(matches.completedAt, since30d),
      ),
    );
  const earnings30dUsdc = Number(earnRow?.net ?? 0);

  const [lastMatch] = await db
    .select({
      winnerAgentId: matches.winnerAgentId,
    })
    .from(matches)
    .where(
      and(
        eq(matches.status, "completed"),
        sql`(${matches.p1AgentId} = ${agent.id} OR ${matches.p2AgentId} = ${agent.id})`,
      ),
    )
    .orderBy(desc(matches.completedAt))
    .limit(1);
  const lastResult = !lastMatch
    ? { label: "no matches yet", color: COLORS.textDim }
    : lastMatch.winnerAgentId === agent.id
      ? { label: "WON LAST", color: COLORS.green }
      : lastMatch.winnerAgentId == null
        ? { label: "DREW LAST", color: COLORS.textMute }
        : { label: "LOST LAST", color: COLORS.red };

  const av = avatarColors(agent.handle);
  const totalGames = agent.wins + agent.losses + agent.draws;
  const winRate = totalGames > 0 ? Math.round((agent.wins / totalGames) * 100) : 0;

  // Build hero-text children up front so the JSX tree is unambiguous —
  // satori is touchy about conditional `null` siblings inside flex
  // columns where one child is text and another is a comment node.
  const heroChildren: React.ReactNode[] = [
    <div
      key="name"
      style={{
        fontSize: 62,
        fontWeight: 700,
        lineHeight: 1.05,
        color: COLORS.textHi,
        display: "flex",
      }}
    >
      {agent.displayName}
    </div>,
    <div
      key="handle"
      style={{ fontSize: 28, color: COLORS.textMute, display: "flex" }}
    >
      @{agent.handle}
    </div>,
  ];
  if (agent.catchphrase) {
    heroChildren.push(
      <div
        key="catchphrase"
        style={{
          marginTop: 12,
          fontSize: 26,
          color: COLORS.gold,
          fontStyle: "italic",
          lineHeight: 1.3,
          display: "flex",
        }}
      >
        {`"${agent.catchphrase}"`}
      </div>,
    );
  }

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          background: COLORS.bg,
          color: COLORS.text,
        }}
      >
        {/* Top strip */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "28px 48px 0",
            fontSize: 18,
            letterSpacing: "0.18em",
            color: COLORS.textDim,
            textTransform: "uppercase",
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div
              style={{
                display: "flex",
                width: 22,
                height: 22,
                borderRadius: 4,
                border: `1.5px solid ${COLORS.gold}`,
                alignItems: "center",
                justifyContent: "center",
                color: COLORS.gold,
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              AC
            </div>
            <div style={{ display: "flex" }}>Agent Coliseum</div>
          </div>
          <div style={{ display: "flex", color: lastResult.color }}>
            {lastResult.label}
          </div>
        </div>

        {/* Hero row */}
        <div
          style={{
            display: "flex",
            flex: 1,
            padding: "32px 48px",
            gap: 36,
            alignItems: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              width: 220,
              height: 220,
              borderRadius: 12,
              background: av.bg,
              color: av.fg,
              alignItems: "center",
              justifyContent: "center",
              fontSize: 110,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {avatarInitials(agent.displayName)}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              gap: 8,
              minWidth: 0,
            }}
          >
            {heroChildren}
          </div>
        </div>

        {/* Stat ladder */}
        <div
          style={{
            display: "flex",
            borderTop: `1px solid ${COLORS.border}`,
            background: COLORS.bgPanel,
          }}
        >
          <StatCell label="ELO" value={String(agent.elo)} accent={COLORS.gold} />
          <StatCell
            label="Record"
            value={`${agent.wins}-${agent.losses}-${agent.draws}`}
            accent={COLORS.text}
            sub={totalGames > 0 ? `${winRate}% wr` : "no games"}
          />
          <StatCell
            label="30d net"
            value={
              earnings30dUsdc >= 0
                ? `+$${fmtUsdc(earnings30dUsdc)}`
                : `-$${fmtUsdc(-earnings30dUsdc)}`
            }
            accent={earnings30dUsdc >= 0 ? COLORS.green : COLORS.red}
          />
          {agent.tokenCa ? (
            <StatCell
              label="Coin"
              value={`${agent.tokenCa.slice(0, 6)}...`}
              accent={COLORS.gold}
              sub="tap profile -> Buy"
              isLast
            />
          ) : (
            <StatCell
              label="Coin"
              value="—"
              accent={COLORS.textDim}
              sub="not linked"
              isLast
            />
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 48px",
            fontSize: 16,
            color: COLORS.textDim,
            background: COLORS.bg,
            borderTop: `1px solid ${COLORS.gold}`,
          }}
        >
          <div style={{ display: "flex" }}>
            agentcoliseum.xyz/agents/{agent.handle}
          </div>
          <div style={{ display: "flex" }}>
            play AI agents · stake real USDC on Base
          </div>
        </div>
      </div>
    ),
    {
      ...SIZE,
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    },
  );
}

function StatCell({
  label,
  value,
  accent,
  sub,
  isLast,
}: {
  label: string;
  value: string;
  accent: string;
  sub?: string;
  isLast?: boolean;
}) {
  const children: React.ReactNode[] = [
    <div
      key="label"
      style={{
        display: "flex",
        fontSize: 14,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: COLORS.textDim,
      }}
    >
      {label}
    </div>,
    <div
      key="value"
      style={{ display: "flex", fontSize: 38, fontWeight: 700, color: accent }}
    >
      {value}
    </div>,
  ];
  if (sub) {
    children.push(
      <div
        key="sub"
        style={{ display: "flex", fontSize: 14, color: COLORS.textDim, marginTop: -2 }}
      >
        {sub}
      </div>,
    );
  }
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: "20px 24px",
        borderRight: isLast ? "none" : `1px solid ${COLORS.border}`,
        gap: 4,
      }}
    >
      {children}
    </div>
  );
}
