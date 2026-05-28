"use client";

/**
 * AgentCard — the per-player rail card on the match page.
 *
 * Mobile-first redesign (2026-05-28): the previous card was a 6-cell
 * stat grid + catchphrase + coin row + clock + button — too much
 * chrome for a spectator who's there to watch a board. Now reduced to
 * the four things actually needed during play:
 *
 *   1. Identity   — avatar, display name, @handle
 *   2. ELO        — the single most-important number
 *   3. Record     — W-L-D as quick form signal
 *   4. Clock      — live ms left (only when running)
 *
 * Plus a "View profile →" link for anyone who wants deep stats. The
 * dropped fields (Win %, Δ this match, Avg think, 7d net, catchphrase,
 * $coin row) all live on the profile page where they have room to
 * breathe.
 *
 * Active-player highlight: when `isTurn` is true, the WHOLE perimeter
 * of the card gets the player-side color — red (ox-bright) for P1,
 * gold for P2. Replaces the old 3px left-edge bar so the active card
 * pops at any scroll distance. CSS in coliseum.css → .agent-card.turn.
 */
import Link from "next/link";
import type { Agent } from "./types";
import { avatarInitials, formatClock } from "./utils";
import { cn } from "@/lib/utils";

interface AgentCardProps {
  agent: Agent | null;
  isTurn: boolean;
  playerSide: "p1" | "p2";
  clockMs: number;
  running: boolean;
  systemFallback?: boolean;
}

export function AgentCard({
  agent,
  isTurn,
  playerSide,
  clockMs,
  running,
  systemFallback,
}: AgentCardProps) {
  const isP1 = playerSide === "p1";
  const chipLabel = isP1 ? "● RED" : "● GOLD";

  // Empty/awaiting state — no agent assigned yet (or system bot).
  if (!agent) {
    return (
      <div
        className={cn(
          "agent-card",
          isTurn && "turn",
          isP1 ? "p1" : "p2",
        )}
      >
        <div className="agent-card-hd">
          <div className="row" style={{ gap: 10, minWidth: 0 }}>
            <span className="av lg" data-c={isP1 ? "0" : "5"}>
              {systemFallback ? "SY" : "??"}
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 16,
                  fontWeight: 600,
                  lineHeight: 1.2,
                }}
              >
                {systemFallback ? "System bot" : "Awaiting opponent"}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
                {systemFallback ? "@system-bot" : "—"}
              </div>
            </div>
          </div>
          <span className={cn("chip", isP1 ? "live" : "gold")}>
            {chipLabel}
          </span>
        </div>
        {running ? (
          <div className="agent-card-bd">
            <ClockRow clockMs={clockMs} running={running} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "agent-card",
        isTurn && "turn",
        isP1 ? "p1" : "p2",
      )}
    >
      <div className="agent-card-hd">
        <div className="row" style={{ gap: 10, minWidth: 0 }}>
          <span className="av lg" data-c={isP1 ? "0" : "5"}>
            {avatarInitials(agent.displayName)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 16,
                fontWeight: 600,
                lineHeight: 1.2,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {agent.displayName}
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
              @{agent.handle}
            </div>
          </div>
        </div>
        <span className={cn("chip", isP1 ? "live" : "gold")}>
          {chipLabel}
        </span>
      </div>

      <div className="agent-card-bd">
        {/* One compact row: ELO · record · clock. Wraps to two lines
            on phones at the same breakpoint that other panels do. */}
        <div className="agent-meta">
          <div className="agent-meta-stat">
            <div className="lbl">ELO</div>
            <div className="val gold">{agent.elo}</div>
          </div>
          <div className="agent-meta-stat">
            <div className="lbl">Record</div>
            <div className="val">
              {agent.wins}-{agent.losses}-{agent.draws}
            </div>
          </div>
          <div className="agent-meta-stat agent-meta-clock">
            <div className="lbl">{running ? "Clock · running" : "Clock"}</div>
            <div className={cn("val mono clock", running && "running")}>
              {formatClock(clockMs)}
            </div>
          </div>
        </div>

        <Link
          href={`/agents/${agent.handle}`}
          className="btn sm grow"
          style={{ textAlign: "center" }}
        >
          View profile →
        </Link>
      </div>
    </div>
  );
}

/**
 * Pulled out so the awaiting-opponent branch can reuse the same
 * styled clock without duplicating markup. Only mounts when the
 * other side's clock is running — empty card otherwise stays
 * single-line height.
 */
function ClockRow({ clockMs, running }: { clockMs: number; running: boolean }) {
  return (
    <div className="agent-meta">
      <div className="agent-meta-stat agent-meta-clock" style={{ flex: 1 }}>
        <div className="lbl">{running ? "Clock · running" : "Clock"}</div>
        <div className={cn("val mono clock", running && "running")}>
          {formatClock(clockMs)}
        </div>
      </div>
    </div>
  );
}
