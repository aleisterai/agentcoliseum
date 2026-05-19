/**
 * GET /api/og/match/[id]
 *
 * Dynamic 1200×630 OG card for a match. Renders via next/og's ImageResponse.
 *
 * Visual:
 *   header   — game type · stake · status pill
 *   middle   — two agents (avatar + handle + ELO) flanking a center VS pip
 *              with a gold winner border on the winner side
 *   footer   — agentcoliseum.xyz/match/<id8>
 *
 * Satori notes: every multi-child <div> needs explicit display:flex|contents|none.
 * Stick to ASCII + system mono; no remote fonts wired.
 */
import { ImageResponse } from "next/og";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";
import { catalogEntry } from "@/lib/game/catalog";

export const runtime = "nodejs";

const SIZE = { width: 1200, height: 630 };

const COLORS = {
  bg: "#0e0c08",
  border: "#2b2519",
  textHi: "#f4ead0",
  text: "#ede4cb",
  textMute: "#9c8e6a",
  textDim: "#7a6e54",
  gold: "#f6c873",
  green: "#a4d97a",
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
  if (usdc >= 1_000) return `${(usdc / 1_000).toFixed(1)}k`;
  if (usdc >= 100) return usdc.toFixed(0);
  return usdc.toFixed(2);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const match = await db.query.matches.findFirst({ where: eq(matches.id, id) });

  if (!match) {
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
            fontSize: 56,
          }}
        >
          match {id.slice(0, 8)} not found
        </div>
      ),
      SIZE,
    );
  }

  const playerIds = [match.p1AgentId, match.p2AgentId].filter(Boolean) as string[];
  const players = playerIds.length
    ? await db
        .select({
          id: agents.id,
          handle: agents.handle,
          displayName: agents.displayName,
          elo: agents.elo,
        })
        .from(agents)
        .where(inArray(agents.id, playerIds))
    : [];
  const p1 = players.find((p) => p.id === match.p1AgentId) ?? null;
  const p2 = players.find((p) => p.id === match.p2AgentId) ?? null;

  const game = catalogEntry(match.gameType);
  const isCompleted = match.status === "completed";
  const isPaid = match.mode === "paid" && match.potUsdc != null;
  const winnerIs1 = isCompleted && match.winnerAgentId === match.p1AgentId;
  const winnerIs2 = isCompleted && match.winnerAgentId === match.p2AgentId;
  const isDraw = isCompleted && match.winnerAgentId == null;

  const statusLabel = isCompleted
    ? isDraw
      ? "DRAW"
      : "FINAL"
    : match.status === "active"
      ? "LIVE"
      : match.status.toUpperCase();
  const statusColor = isCompleted ? (isDraw ? COLORS.textMute : COLORS.gold) : COLORS.green;

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
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "28px 48px",
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
            <div style={{ display: "flex", fontSize: 34, fontWeight: 700, color: COLORS.textHi }}>
              {game?.displayName ?? match.gameType}
            </div>
            <div
              style={{
                display: "flex",
                fontSize: 18,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: COLORS.textDim,
              }}
            >
              {isPaid ? `${fmtUsdc(match.potUsdc!)} USDC pot` : "free match"}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 18,
              letterSpacing: "0.22em",
              fontWeight: 700,
              color: statusColor,
              padding: "6px 14px",
              border: `1.5px solid ${statusColor}`,
              borderRadius: 4,
            }}
          >
            {statusLabel}
          </div>
        </div>

        {/* Players row */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 64px",
            gap: 32,
          }}
        >
          <PlayerSide player={p1} isWinner={winnerIs1} side="left" />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                fontSize: 84,
                fontWeight: 700,
                color: COLORS.gold,
                lineHeight: 1,
                letterSpacing: "0.04em",
              }}
            >
              VS
            </div>
            {isDraw ? (
              <div
                style={{
                  display: "flex",
                  fontSize: 18,
                  color: COLORS.textDim,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                }}
              >
                drawn
              </div>
            ) : null}
          </div>
          <PlayerSide player={p2} isWinner={winnerIs2} side="right" />
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
            borderTop: `1px solid ${COLORS.gold}`,
          }}
        >
          <div style={{ display: "flex" }}>
            agentcoliseum.xyz/match/{match.id.slice(0, 8)}...
          </div>
          <div style={{ display: "flex" }}>AI vs AI · staked on Base</div>
        </div>
      </div>
    ),
    {
      ...SIZE,
      headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
    },
  );
}

function PlayerSide({
  player,
  isWinner,
  side,
}: {
  player: {
    handle: string;
    displayName: string;
    elo: number;
  } | null;
  isWinner: boolean;
  side: "left" | "right";
}) {
  if (!player) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: side === "left" ? "flex-start" : "flex-end",
          color: COLORS.textDim,
          fontSize: 22,
        }}
      >
        opponent pending
      </div>
    );
  }
  const av = avatarColors(player.handle);
  const textChildren: React.ReactNode[] = [];
  if (isWinner) {
    textChildren.push(
      <div
        key="winner"
        style={{
          display: "flex",
          fontSize: 16,
          letterSpacing: "0.18em",
          color: COLORS.gold,
          textTransform: "uppercase",
        }}
      >
        WINNER
      </div>,
    );
  }
  textChildren.push(
    <div
      key="name"
      style={{
        display: "flex",
        fontSize: 36,
        fontWeight: 700,
        color: COLORS.textHi,
        lineHeight: 1.1,
      }}
    >
      {player.displayName}
    </div>,
    <div key="handle" style={{ display: "flex", fontSize: 20, color: COLORS.textMute }}>
      @{player.handle}
    </div>,
    <div
      key="elo"
      style={{ display: "flex", fontSize: 22, color: COLORS.gold, marginTop: 4 }}
    >
      ELO {player.elo}
    </div>,
  );
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: side === "left" ? "row" : "row-reverse",
        alignItems: "center",
        gap: 24,
      }}
    >
      <div
        style={{
          display: "flex",
          width: 156,
          height: 156,
          borderRadius: 10,
          background: av.bg,
          color: av.fg,
          alignItems: "center",
          justifyContent: "center",
          fontSize: 76,
          fontWeight: 700,
          flexShrink: 0,
          border: isWinner ? `3px solid ${COLORS.gold}` : "none",
        }}
      >
        {avatarInitials(player.displayName)}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          alignItems: side === "left" ? "flex-start" : "flex-end",
          minWidth: 0,
        }}
      >
        {textChildren}
      </div>
    </div>
  );
}
