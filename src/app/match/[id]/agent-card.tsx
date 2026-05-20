"use client";

/**
 * AgentCard — the per-player rail card on the match page. Renders the
 * agent's avatar, handle, ELO/win-rate/Δ stats, coin info (if linked),
 * voice catchphrase, the live clock, and the "View profile" link.
 *
 * Used twice on the match page (P1 / P2). The `playerSide` prop drives
 * red-vs-gold accent color. `running` is true when it's this player's
 * turn — drives the clock-pulse animation.
 */
import Link from "next/link";
import type { Agent } from "./types";
import { avatarInitials, formatClock, formatThink } from "./utils";
import { cn } from "@/lib/utils";

interface AgentCardProps {
  agent: Agent | null;
  isTurn: boolean;
  playerSide: "p1" | "p2";
  clockMs: number;
  running: boolean;
  avgThinkMs: number | null;
  systemFallback?: boolean;
}

export function AgentCard({
  agent,
  isTurn,
  playerSide,
  clockMs,
  running,
  avgThinkMs,
  systemFallback,
}: AgentCardProps) {
  const isP1 = playerSide === "p1";
  const chipColor = isP1 ? "var(--ox-bright)" : "var(--gold)";
  const chipBg = isP1
    ? "color-mix(in oklab, var(--ox) 10%, transparent)"
    : "color-mix(in oklab, var(--gold) 8%, transparent)";
  const chipBorder = isP1
    ? "color-mix(in oklab, var(--ox) 35%, transparent)"
    : "color-mix(in oklab, var(--gold) 35%, transparent)";
  const chipLabel = isP1 ? "● RED" : "● GOLD";

  if (!agent) {
    return (
      <div className={cn("agent-card", isTurn && "turn")}>
        <div className="agent-card-hd">
          <div className="row" style={{ gap: 10 }}>
            <span className="av lg" data-c={isP1 ? "0" : "5"}>
              {systemFallback ? "SY" : "??"}
            </span>
            <div>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 18,
                  fontWeight: 600,
                }}
              >
                {systemFallback ? "System bot" : "Awaiting opponent"}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
                {systemFallback ? "@system-bot" : "—"}
              </div>
            </div>
          </div>
          <span
            className="chip"
            style={{ color: chipColor, borderColor: chipBorder, background: chipBg }}
          >
            {chipLabel}
          </span>
        </div>
        {running ? (
          <div className="agent-card-bd">
            <div className="clock-row">
              <div className="lbl">Clock · running</div>
              <div className="clock mono running">{formatClock(clockMs)}</div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const totalGames = agent.wins + agent.losses + agent.draws;
  const winPct =
    totalGames === 0 ? 0 : Math.round((agent.wins / totalGames) * 1000) / 10;

  const earnings7d = agent.earnings7dUsdc;
  const earnings7dLabel =
    earnings7d === 0
      ? "—"
      : earnings7d > 0
        ? `+${(earnings7d / 1_000_000).toFixed(2)}`
        : `−${(-earnings7d / 1_000_000).toFixed(2)}`;

  return (
    <div className={cn("agent-card", isTurn && "turn")}>
      <div className="agent-card-hd">
        <div className="row" style={{ gap: 10 }}>
          <span className="av lg" data-c={isP1 ? "0" : "5"}>
            {avatarInitials(agent.displayName)}
          </span>
          <div>
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 18,
                fontWeight: 600,
              }}
            >
              {agent.displayName}
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
              @{agent.handle}
            </div>
          </div>
        </div>
        <span
          className="chip"
          style={{ color: chipColor, borderColor: chipBorder, background: chipBg }}
        >
          {chipLabel}
        </span>
      </div>
      {agent.catchphrase ? (
        <div
          style={{
            padding: "8px 14px 0",
            fontSize: 12,
            fontStyle: "italic",
            color: "var(--gold)",
            lineHeight: 1.35,
          }}
        >
          &ldquo;{agent.catchphrase}&rdquo;
        </div>
      ) : null}
      <div className="agent-card-bd">
        <div className="stat-grid">
          <div>
            <div className="lbl">ELO</div>
            <div className="val gold">{agent.elo}</div>
          </div>
          <div>
            <div className="lbl">Win %</div>
            <div className="val">{winPct}%</div>
          </div>
          <div>
            <div className="lbl">Δ this match</div>
            <div
              className={cn(
                "val",
                agent.eloDelta != null && agent.eloDelta >= 0 ? "up" : "down",
              )}
            >
              {agent.eloDelta == null
                ? "—"
                : agent.eloDelta >= 0
                  ? `+${agent.eloDelta}`
                  : `${agent.eloDelta}`}
            </div>
          </div>
          <div>
            <div className="lbl">Avg think</div>
            <div className="val">{avgThinkMs == null ? "—" : formatThink(avgThinkMs)}</div>
          </div>
          <div>
            <div className="lbl">Record</div>
            <div className="val">
              {agent.wins}-{agent.losses}-{agent.draws}
            </div>
          </div>
          <div>
            <div className="lbl">7d net</div>
            <div
              className={cn(
                "val",
                "mono",
                earnings7d > 0 ? "up" : earnings7d < 0 ? "down" : "mute",
              )}
              style={{ fontSize: 12 }}
            >
              {earnings7dLabel === "—" ? "—" : `◆ ${earnings7dLabel}`}
            </div>
          </div>
        </div>
        {agent.coin ? (
          <div
            className="row"
            style={{
              marginTop: 10,
              padding: "8px 10px",
              background: "color-mix(in oklab, var(--gold) 8%, transparent)",
              border: "1px solid color-mix(in oklab, var(--gold) 35%, transparent)",
              borderRadius: 4,
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span
                className="mono"
                style={{ color: "var(--gold)", fontSize: 13, fontWeight: 600 }}
              >
                ${agent.coin.symbol}
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: "var(--text-mute)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 140,
                }}
              >
                {agent.coin.name}
              </span>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <a
                className="lnk-gold mono"
                href={agent.coin.uniswapBuyUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 11 }}
              >
                Buy ↗
              </a>
              <a
                className="lnk mono"
                href={agent.coin.dexscreenerUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 11, color: "var(--text-mute)" }}
              >
                Chart ↗
              </a>
            </div>
          </div>
        ) : null}
        <div className="clock-row">
          <div className="lbl">Clock · {running ? "running" : "waiting"}</div>
          <div className={cn("clock mono", running && "running")}>
            {formatClock(clockMs)}
          </div>
        </div>
        <div className="agent-actions">
          <Link
            href={`/agents/${agent.handle}`}
            className="btn sm grow"
            style={{ textAlign: "center" }}
          >
            View profile
          </Link>
        </div>
      </div>
    </div>
  );
}
