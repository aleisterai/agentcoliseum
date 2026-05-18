"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createPublicClient, channelName, realtimeEvent } from "@/lib/supabase";
import { GameBoard } from "@/components/coliseum/game-board";
import { cn } from "@/lib/utils";

/**
 * MatchView — 1:1 port of design's match.html (Coliseum Terminal).
 *
 * 3-column layout: P1 rail (agent card + reasoning trace) · board+scrubber+log
 * tabs · P2 rail (agent card + spectator chat).
 *
 * Realtime: subscribes to `match:{id}` for move.played, chat.message, reaction,
 * match.ended.
 */

type Move = {
  moveNumber: number;
  agentId: string | null;
  playerId: "0" | "1";
  /** Game-specific move payload (e.g. { column: 3 } or { index: 4 }). */
  payload: unknown;
  /** boardgame.io G after the move was applied. Shape is gameType-specific. */
  stateAfterG: unknown;
  reasoning: string | null;
  evScore: number | null;
  thinkingMs: number;
  x402PaymentId: string | null;
  createdAt: string;
};

type Agent = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  tokenCa: string | null;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  eloDelta: number | null;
};

export type MatchViewProps = {
  initial: {
    id: string;
    gameType: string;
    mode: "free" | "paid" | "system";
    status: "active" | "resolving" | "completed" | "abandoned" | "disputed";
    stakeUsdc: number | null;
    potUsdc: number | null;
    /** Initial boardgame.io G — shape varies per gameType. */
    stateG: unknown;
    currentTurnAgentId: string | null;
    currentTurnPlayerId: "0" | "1";
    turnStartedAt: string;
    winnerAgentId: string | null;
    resultReason: string | null;
    clockBudgetMs: number;
    p1MsLeft: number;
    p2MsLeft: number;
    moveCount: number;
    p1: Agent | null;
    p2: Agent | null;
    isSystemGame: boolean;
    startedAt: string;
    completedAt: string | null;
    moves: Move[];
    chat: Array<{
      id: string;
      speakerOwnerId: string | null;
      anonymousToken: string | null;
      body: string;
      createdAt: string;
    }>;
    reactions: Array<{ emoji: string; count: number }>;
  };
};

const REACTION_PALETTE = ["🔥", "🧠", "💀", "👀", "📈", "🩸", "🎯", "🤖"];

export function MatchView({ initial }: MatchViewProps) {
  const [moves, setMoves] = useState<Move[]>(initial.moves);
  const [chat, setChat] = useState(initial.chat);
  const [reactions, setReactions] = useState(initial.reactions);
  const [stateG, setStateG] = useState<unknown>(initial.stateG);
  const [currentTurnPlayerId, setCurrentTurnPlayerId] = useState(initial.currentTurnPlayerId);
  const [status, setStatus] = useState(initial.status);
  const [p1MsLeft, setP1MsLeft] = useState(initial.p1MsLeft);
  const [p2MsLeft, setP2MsLeft] = useState(initial.p2MsLeft);
  const [turnStartedAt, setTurnStartedAt] = useState(initial.turnStartedAt);
  const [now, setNow] = useState(() => Date.now());

  const [scrubIndex, setScrubIndex] = useState<number>(Math.max(0, initial.moves.length - 1));
  const [liveMode, setLiveMode] = useState(initial.status === "active");
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<0.5 | 1 | 2 | 4>(1);

  const [logTab, setLogTab] = useState<"moves" | "x402" | "annot">("moves");
  const [chatInput, setChatInput] = useState("");
  const chatStreamRef = useRef<HTMLDivElement | null>(null);

  const liveMoveIdx = moves.length - 1;
  const effectiveIdx = liveMode ? liveMoveIdx : scrubIndex;

  /** The boardgame.io G to render right now. Opaque shape per gameType. */
  const displayedStateG = useMemo(() => {
    if (moves.length === 0 || effectiveIdx < 0) return stateG;
    return moves[effectiveIdx]?.stateAfterG ?? stateG;
  }, [effectiveIdx, moves, stateG]);

  /**
   * Last-move marker, opaque per gameType. The GameBoard dispatcher unpacks
   * it for the right renderer:
   *   - connect4 → [row, col]
   *   - tic-tac-toe → flat cell index 0..8
   */
  const lastMoveMarker = useMemo(() => {
    if (effectiveIdx < 0 || moves.length === 0) return null;
    const m = moves[effectiveIdx];
    if (!m) return null;
    return extractLastMove(initial.gameType, m.payload, m.stateAfterG);
  }, [effectiveIdx, moves, initial.gameType]);

  // 1Hz ticker for elapsed time + clocks
  useEffect(() => {
    if (status !== "active") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  // Replay autoplay
  useEffect(() => {
    if (!isPlaying || moves.length === 0) return;
    const interval = 1000 / speed;
    const t = setInterval(() => {
      setScrubIndex((i) => {
        if (i >= moves.length - 1) {
          setIsPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, interval);
    return () => clearInterval(t);
  }, [isPlaying, speed, moves.length]);

  // Realtime
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    try {
      const sb = createPublicClient();
      const ch = sb.channel(channelName.game(initial.id));

      ch.on("broadcast", { event: realtimeEvent.MovePlayed }, (e: { payload: unknown }) => {
        const p = e.payload as Partial<{
          moveNumber: number;
          payload: unknown;
          stateAfterG: unknown;
          currentTurnPlayerId: "0" | "1";
          turnStartedAt: string;
          p1MsLeft: number;
          p2MsLeft: number;
          reasoning: string | null;
          evScore: number | null;
          thinkingMs: number;
          x402PaymentId: string | null;
        }>;
        if (p.moveNumber == null || p.stateAfterG == null) return;
        const justMovedPid: "0" | "1" = p.currentTurnPlayerId === "0" ? "1" : "0";
        setMoves((prev) => {
          if (prev.some((x) => x.moveNumber === p.moveNumber)) return prev;
          const next: Move = {
            moveNumber: p.moveNumber!,
            agentId:
              justMovedPid === "0" ? initial.p1?.id ?? null : initial.p2?.id ?? null,
            playerId: justMovedPid,
            payload: p.payload ?? null,
            stateAfterG: p.stateAfterG ?? null,
            reasoning: p.reasoning ?? null,
            evScore: p.evScore ?? null,
            thinkingMs: p.thinkingMs ?? 0,
            x402PaymentId: p.x402PaymentId ?? null,
            createdAt: new Date().toISOString(),
          };
          return [...prev, next];
        });
        setStateG(p.stateAfterG);
        if (p.currentTurnPlayerId) setCurrentTurnPlayerId(p.currentTurnPlayerId);
        if (p.turnStartedAt) setTurnStartedAt(p.turnStartedAt);
        if (p.p1MsLeft != null) setP1MsLeft(p.p1MsLeft);
        if (p.p2MsLeft != null) setP2MsLeft(p.p2MsLeft);
      });

      ch.on("broadcast", { event: realtimeEvent.ChatMessage }, (e: { payload: unknown }) => {
        const p = e.payload as {
          id: string;
          speakerOwnerId: string | null;
          anonymousToken: string | null;
          body: string;
          createdAt: string;
        };
        setChat((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
      });

      ch.on("broadcast", { event: realtimeEvent.Reaction }, (e: { payload: unknown }) => {
        const p = e.payload as { emoji: string };
        setReactions((prev) => bumpReaction(prev, p.emoji));
      });

      ch.on("broadcast", { event: realtimeEvent.GameEnded }, () => {
        setStatus("completed");
        setLiveMode(false);
      });

      ch.subscribe();
      return () => {
        sb.removeChannel(ch);
      };
    } catch {
      /* realtime not configured */
    }
  }, [initial.id, initial.p1?.id, initial.p2?.id]);

  // Auto-scroll chat
  useEffect(() => {
    const el = chatStreamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  // Live tick-down of the running clock
  const liveP1Ms = useMemo(() => {
    if (status !== "active" || currentTurnPlayerId !== "0") return p1MsLeft;
    return Math.max(0, p1MsLeft - (now - new Date(turnStartedAt).getTime()));
  }, [status, currentTurnPlayerId, p1MsLeft, turnStartedAt, now]);

  const liveP2Ms = useMemo(() => {
    if (status !== "active" || currentTurnPlayerId !== "1") return p2MsLeft;
    return Math.max(0, p2MsLeft - (now - new Date(turnStartedAt).getTime()));
  }, [status, currentTurnPlayerId, p2MsLeft, turnStartedAt, now]);

  const traceItems = useMemo(() => {
    return moves
      .filter((m) => m.playerId === "0")
      .slice(-7)
      .reverse()
      .map((m, i) => ({
        ts: new Date(m.createdAt).toLocaleTimeString("en-US", { hour12: false }),
        cur: i === 0,
        move: describeMove(initial.gameType, m.payload),
        ev:
          m.evScore != null
            ? m.evScore >= 0
              ? `+${m.evScore.toFixed(2)}`
              : m.evScore.toFixed(2)
            : null,
        evDown: m.evScore != null && m.evScore < 0,
        text: m.reasoning || "—",
      }));
  }, [moves, initial.gameType]);

  async function sendChat() {
    const body = chatInput.trim();
    if (!body) return;
    setChatInput("");
    try {
      await fetch(`/api/match/${initial.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    } catch {
      /* realtime will reconcile */
    }
  }

  async function sendReaction(emoji: string) {
    setReactions((prev) => bumpReaction(prev, emoji));
    try {
      await fetch(`/api/match/${initial.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction: emoji }),
      });
    } catch {
      /* swallow */
    }
  }

  const annotationMarkers = useMemo(() => {
    if (moves.length === 0) return [];
    return moves
      .map((m, idx) => ({ m, idx }))
      .filter(({ m }) => m.evScore != null && Math.abs(m.evScore) >= 0.15)
      .map(({ m, idx }) => ({
        pct: ((idx + 1) / Math.max(1, moves.length)) * 100,
        label: m.evScore != null && m.evScore >= 0.15 ? "EV swing ↑" : "EV swing ↓",
        gold: m.evScore != null && m.evScore >= 0.15,
      }));
  }, [moves]);

  const scrubFillPct = moves.length === 0 ? 0 : ((effectiveIdx + 1) / moves.length) * 100;
  const watchingCount = chat.length;

  return (
    <main className="page" id="page">
      {/* Status strip */}
      <section className="match-strip">
        <div className="strip-l">
          <Link href="/lobby" className="lnk mono" style={{ fontSize: 11 }}>
            ← all matches
          </Link>
          <span className="dim mono">·</span>
          {status === "active" ? (
            <span className="pulse">
              <span className="pulse-dot" /> LIVE
            </span>
          ) : status === "completed" ? (
            <span className="mono" style={{ fontSize: 11, color: "var(--gold)" }}>
              ✓ FINAL
            </span>
          ) : (
            <span className="mono dim" style={{ fontSize: 11 }}>
              {status.toUpperCase()}
            </span>
          )}
          <span className="dim mono">·</span>
          <span className="mono" style={{ fontSize: 12 }}>
            {catalogLabel(initial.gameType)}
          </span>
          <span className="dim mono">·</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
            id {initial.id.slice(0, 8)}
          </span>
        </div>
        <div className="strip-r">
          <span className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
            elapsed{" "}
            <span className="up">{formatElapsed(initial.startedAt, initial.completedAt, now)}</span>
          </span>
          <span className="dim mono">·</span>
          <span className="mono" style={{ fontSize: 11 }}>
            <span className="dim">move</span> {moves.length}
          </span>
          <span className="dim mono">·</span>
          <span className="mono" style={{ fontSize: 11 }}>
            <span className="dim">👁</span> {watchingCount} watching
          </span>
          {initial.potUsdc != null ? (
            <>
              <span className="dim mono">·</span>
              <span className="money">{formatUsdcMicro(initial.potUsdc)} USDC pot</span>
            </>
          ) : null}
        </div>
      </section>

      {/* 3-column */}
      <section className="match-grid">
        {/* LEFT */}
        <aside className="rail-col">
          <AgentCard
            agent={initial.p1}
            isTurn={status === "active" && currentTurnPlayerId === "0"}
            playerSide="p1"
            clockMs={liveP1Ms}
            running={status === "active" && currentTurnPlayerId === "0"}
            avgThinkMs={avgThinkOfPlayer(moves, "0")}
          />
          <div
            className="panel"
            style={{ flex: 1, minHeight: 280, display: "flex", flexDirection: "column" }}
          >
            <div className="panel-hd">
              <span className="panel-hd-title">
                Reasoning · @{initial.p1?.handle ?? "p1"}
              </span>
              <span className="panel-hd-meta mono" style={{ fontSize: 10.5 }}>
                {status === "active" ? "live trace" : "final trace"}
              </span>
            </div>
            <div className="trace">
              {traceItems.length === 0 ? (
                <div className="item">
                  <div style={{ color: "var(--text-mute)" }}>No reasoning yet.</div>
                </div>
              ) : (
                traceItems.map((t, i) => (
                  <div key={i} className={cn("item", t.cur && "cur")}>
                    <span className="ts">{t.ts}</span>
                    <span className="move">{t.move}</span>
                    {t.ev ? (
                      <span className={cn("ev", t.evDown && "down")}> · EV {t.ev}</span>
                    ) : null}
                    <div style={{ marginTop: 3 }}>{t.text}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>

        {/* CENTER */}
        <div className="board-col">
          <div className="panel board-panel">
            <div className="panel-hd">
              <div className="row" style={{ gap: 10 }}>
                <span className="panel-hd-title">
                  {status === "active" ? "Live board" : "Final board"}
                </span>
                {status === "active" ? (
                  <span className="chip live" style={{ fontSize: 9.5 }}>
                    <span className="pulse-dot" style={{ marginRight: 4 }} />
                    SYNCED
                  </span>
                ) : null}
              </div>
            </div>
            <div className="board-stage">
              <div className="board-wrap">
                <GameBoard
                  gameType={initial.gameType}
                  state={displayedStateG}
                  lastMove={lastMoveMarker}
                />
              </div>
            </div>

            <div className="scrub">
              <ScrubberTrack
                fillPct={scrubFillPct}
                cursorPct={scrubFillPct}
                markers={annotationMarkers}
                onSeek={(pct) => {
                  if (moves.length === 0) return;
                  const idx = Math.min(
                    moves.length - 1,
                    Math.max(0, Math.round((pct / 100) * moves.length) - 1),
                  );
                  setLiveMode(false);
                  setIsPlaying(false);
                  setScrubIndex(idx);
                }}
              />
              <div className="scrub-ctrls">
                <button
                  className="btn sm"
                  onClick={() => {
                    setLiveMode(false);
                    setScrubIndex(0);
                  }}
                >
                  ⏮
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    setLiveMode(false);
                    setScrubIndex((i) => Math.max(0, i - 1));
                  }}
                >
                  ◀
                </button>
                <button
                  className={cn("btn sm", (liveMode || isPlaying) && "primary")}
                  onClick={() => {
                    if (status === "active" && !liveMode) {
                      setLiveMode(true);
                      setIsPlaying(false);
                    } else if (isPlaying) {
                      setIsPlaying(false);
                    } else {
                      setLiveMode(false);
                      setIsPlaying(true);
                    }
                  }}
                >
                  {status === "active" && liveMode
                    ? "⏸ Live"
                    : isPlaying
                      ? "⏸ Pause"
                      : "▶ Replay"}
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    setLiveMode(false);
                    setScrubIndex((i) => Math.min(moves.length - 1, i + 1));
                  }}
                >
                  ▶
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    setLiveMode(true);
                    setScrubIndex(Math.max(0, moves.length - 1));
                  }}
                >
                  ⏭
                </button>
                <span
                  className="mono"
                  style={{ fontSize: 11, color: "var(--text-mute)", marginLeft: 6 }}
                >
                  move {Math.max(0, effectiveIdx) + (moves.length > 0 ? 1 : 0)} /{" "}
                  {liveMode && status === "active" ? "live" : moves.length}
                </span>
                <span className="grow" />
                <div className="seg-pill">
                  {([0.5, 1, 2, 4] as const).map((s) => (
                    <button
                      key={s}
                      className={speed === s ? "on" : ""}
                      onClick={() => setSpeed(s)}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Tabbed log */}
          <div className="panel">
            <div className="panel-hd">
              <div className="tabbar">
                <button
                  className={cn("tab", logTab === "moves" && "on")}
                  onClick={() => setLogTab("moves")}
                >
                  Move log <span className="ct mono">{moves.length}</span>
                </button>
                <button
                  className={cn("tab", logTab === "x402" && "on")}
                  onClick={() => setLogTab("x402")}
                >
                  x402 payments
                </button>
                <button
                  className={cn("tab", logTab === "annot" && "on")}
                  onClick={() => setLogTab("annot")}
                >
                  Annotations
                </button>
              </div>
              <span className="panel-hd-meta mono">jump · click any row</span>
            </div>
            <div className="panel-bd-flush">
              {logTab === "moves" && (
                <MoveLog
                  gameType={initial.gameType}
                  moves={moves}
                  p1={initial.p1}
                  p2={initial.p2}
                  currentIdx={effectiveIdx}
                  onJump={(idx) => {
                    setLiveMode(false);
                    setIsPlaying(false);
                    setScrubIndex(idx);
                  }}
                />
              )}
              {logTab === "x402" && <X402Log moves={moves} />}
              {logTab === "annot" && (
                <AnnotLog
                  gameType={initial.gameType}
                  moves={moves}
                  p1={initial.p1}
                  p2={initial.p2}
                />
              )}
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <aside className="rail-col">
          <AgentCard
            agent={initial.isSystemGame ? null : initial.p2}
            isTurn={status === "active" && currentTurnPlayerId === "1"}
            playerSide="p2"
            clockMs={liveP2Ms}
            running={status === "active" && currentTurnPlayerId === "1"}
            avgThinkMs={avgThinkOfPlayer(moves, "1")}
            systemFallback={initial.isSystemGame}
          />

          <div className="panel chat-panel">
            <div className="panel-hd">
              <span className="panel-hd-title">
                Spectator chat <span className="ct mono">{watchingCount}</span>
              </span>
            </div>
            <div className="chat-stream" ref={chatStreamRef}>
              {chat.length === 0 ? (
                <div className="msg sys">— no messages yet —</div>
              ) : (
                chat.map((m) => (
                  <div key={m.id} className="msg">
                    <span className="who">
                      @{(m.anonymousToken ?? m.speakerOwnerId ?? "viewer").slice(0, 8)}
                    </span>
                    <span className="body">{m.body}</span>
                  </div>
                ))
              )}
            </div>
            <div className="chat-reacts">
              {REACTION_PALETTE.map((e) => {
                const found = reactions.find((r) => r.emoji === e);
                return (
                  <button key={e} className="reactbtn" onClick={() => sendReaction(e)}>
                    {e} <span className="ct">{found?.count ?? 0}</span>
                  </button>
                );
              })}
            </div>
            <div className="chat-input">
              <input
                className="input"
                placeholder="Comment as @viewer…"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    sendChat();
                  }
                }}
              />
              <button className="btn primary sm" onClick={sendChat}>
                Send
              </button>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

// ---------- Sub-components ----------

function AgentCard({
  agent,
  isTurn,
  playerSide,
  clockMs,
  running,
  avgThinkMs,
  systemFallback,
}: {
  agent: Agent | null;
  isTurn: boolean;
  playerSide: "p1" | "p2";
  clockMs: number;
  running: boolean;
  avgThinkMs: number | null;
  systemFallback?: boolean;
}) {
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
              <div
                className="mono"
                style={{ fontSize: 11, color: "var(--text-mute)" }}
              >
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
            <div className="lbl">Token</div>
            <div className="val mute" style={{ fontSize: 11 }}>
              {shortAddr(agent.tokenCa)}
            </div>
          </div>
        </div>
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

function ScrubberTrack({
  fillPct,
  cursorPct,
  markers,
  onSeek,
}: {
  fillPct: number;
  cursorPct: number;
  markers: Array<{ pct: number; label: string; gold?: boolean }>;
  onSeek: (pct: number) => void;
}) {
  return (
    <div
      className="scrub-track"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * 100);
      }}
    >
      <div className="scrub-fill" style={{ width: `${fillPct}%` }} />
      {markers.map((m, i) => (
        <div
          key={i}
          className={cn("scrub-mark", m.gold && "gold")}
          style={{ left: `${m.pct}%` }}
          data-l={m.label}
        />
      ))}
      <div className="scrub-cursor" style={{ left: `${cursorPct}%` }} />
    </div>
  );
}

function MoveLog({
  gameType,
  moves,
  p1,
  p2,
  currentIdx,
  onJump,
}: {
  gameType: string;
  moves: Move[];
  p1: Agent | null;
  p2: Agent | null;
  currentIdx: number;
  onJump: (idx: number) => void;
}) {
  if (moves.length === 0) {
    return (
      <div
        style={{
          padding: 18,
          color: "var(--text-mute)",
          textAlign: "center",
          fontSize: 12,
        }}
      >
        No moves yet.
      </div>
    );
  }
  const ordered = moves.map((m, idx) => ({ m, idx })).reverse();
  return (
    <div className="log-rows">
      {ordered.map(({ m, idx }) => {
        const who = m.playerId === "0" ? p1 : p2;
        const isP1 = m.playerId === "0";
        return (
          <div
            key={m.moveNumber}
            className={cn("log-row", idx === currentIdx && "cur")}
            onClick={() => onJump(idx)}
            style={{ cursor: "pointer" }}
          >
            <div className="log-num">{m.moveNumber + 1}</div>
            <div
              className="log-who"
              style={{ color: isP1 ? "var(--ox-bright)" : "var(--gold)" }}
            >
              @{who?.handle ?? (isP1 ? "p1" : "p2")}
            </div>
            <div className="log-move">{describeMove(gameType, m.payload)}</div>
            <div className="log-meta">{formatThink(m.thinkingMs)}</div>
            <div className={cn("log-pay", !m.x402PaymentId && "fail")}>
              {m.x402PaymentId ? "paid ✓" : "—"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function X402Log({ moves }: { moves: Move[] }) {
  const paid = moves.filter((m) => m.x402PaymentId);
  if (paid.length === 0) {
    return (
      <div
        style={{
          padding: 18,
          color: "var(--text-mute)",
          textAlign: "center",
          fontSize: 12,
        }}
      >
        No x402 settlements (free or system match).
      </div>
    );
  }
  return (
    <div className="log-rows">
      {paid
        .slice()
        .reverse()
        .map((m) => (
          <div key={m.moveNumber} className="log-row">
            <div className="log-num">#{m.moveNumber + 1}</div>
            <div className="log-who mono" style={{ color: "var(--text-mute)" }}>
              {m.x402PaymentId?.slice(0, 10) ?? "—"}…
            </div>
            <div className="log-move mono">
              <span style={{ color: "var(--gold)" }}>x402 settled</span>
            </div>
            <div className="log-meta">facilitator · base</div>
            <div className="log-pay">
              {new Date(m.createdAt).toLocaleTimeString()}
            </div>
          </div>
        ))}
    </div>
  );
}

function AnnotLog({
  gameType,
  moves,
  p1,
  p2,
}: {
  gameType: string;
  moves: Move[];
  p1: Agent | null;
  p2: Agent | null;
}) {
  void gameType;
  const items = moves
    .filter((m) => m.reasoning || (m.evScore != null && Math.abs(m.evScore) >= 0.1))
    .slice()
    .reverse();
  if (items.length === 0) {
    return (
      <div
        style={{
          padding: 18,
          color: "var(--text-mute)",
          textAlign: "center",
          fontSize: 12,
        }}
      >
        No annotations yet.
      </div>
    );
  }
  return (
    <div className="log-rows">
      {items.map((m) => {
        const who = m.playerId === "0" ? p1 : p2;
        return (
          <div key={m.moveNumber} className="log-row">
            <div className="log-num">{m.moveNumber + 1}</div>
            <div className="log-who">
              <span className="chip" style={{ fontSize: 9 }}>
                AUTO
              </span>
            </div>
            <div
              className="log-move"
              style={{ whiteSpace: "normal", color: "var(--text-2)" }}
            >
              <span
                className="mono"
                style={{ color: "var(--gold)", fontSize: 11 }}
              >
                @{who?.handle ?? "?"} ·{" "}
              </span>
              {m.reasoning ?? `EV ${m.evScore?.toFixed(2) ?? "—"}`}
            </div>
            <div className="log-meta">{formatThink(m.thinkingMs)}</div>
            <div className="log-pay">
              <span className="mono">
                {m.evScore != null
                  ? m.evScore >= 0
                    ? `+${m.evScore.toFixed(2)}`
                    : m.evScore.toFixed(2)
                  : "—"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- helpers ----------

function avatarInitials(displayName: string): string {
  const parts = displayName.split(/[\s.\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return displayName.slice(0, 2).toUpperCase();
}

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatThink(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatUsdcMicro(units: number | null | undefined): string {
  if (units == null) return "—";
  return (units / 1_000_000).toFixed(3);
}

function formatElapsed(
  startedAt: string,
  completedAt: string | null,
  nowMs: number,
): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : nowMs;
  let s = Math.max(0, Math.floor((end - start) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${h.toString().padStart(2, "0")}:${m
    .toString()
    .padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * Per-gameType move-payload → human-readable label. The reasoning trace and
 * move log call this for every move. New games extend the switch.
 */
function describeMove(gameType: string, payload: unknown): string {
  if (gameType === "connect4") {
    const col = (payload as { column?: number } | null)?.column;
    return typeof col === "number" ? `drop col ${col + 1}` : "—";
  }
  if (gameType === "tic-tac-toe") {
    const idx = (payload as { index?: number } | null)?.index;
    if (typeof idx !== "number") return "—";
    const labels = ["TL", "T", "TR", "L", "C", "R", "BL", "B", "BR"];
    return `place ${labels[idx] ?? `cell ${idx}`}`;
  }
  if (gameType === "chess") {
    const p = payload as { from?: string; to?: string; promotion?: string } | null;
    if (!p?.from || !p?.to) return "—";
    return p.promotion ? `${p.from}–${p.to}=${p.promotion}` : `${p.from}–${p.to}`;
  }
  if (gameType === "checkers") {
    const p = payload as { from?: [number, number]; path?: Array<[number, number]> } | null;
    if (!p?.from || !p?.path?.length) return "—";
    const labelOf = ([r, c]: [number, number]) => `${"abcdefgh"[c]}${8 - r}`;
    const allSquares = [p.from, ...p.path];
    return allSquares.length > 2
      ? allSquares.map(labelOf).join("×") // multi-jump
      : `${labelOf(p.from)}–${labelOf(p.path[0])}`;
  }
  if (gameType === "reversi") {
    const p = payload as { row?: number; col?: number } | null;
    if (typeof p?.row !== "number" || typeof p?.col !== "number") return "—";
    return `${"abcdefgh"[p.col]}${8 - p.row}`;
  }
  if (gameType === "gomoku") {
    const p = payload as { row?: number; col?: number } | null;
    if (typeof p?.row !== "number" || typeof p?.col !== "number") return "—";
    return `(${p.row}, ${p.col})`;
  }
  if (gameType === "dots-and-boxes") {
    const p = payload as { type?: string; row?: number; col?: number } | null;
    if (!p?.type || typeof p?.row !== "number" || typeof p?.col !== "number") return "—";
    return `${p.type === "h" ? "─" : "│"} (${p.row}, ${p.col})`;
  }
  if (gameType === "mancala") {
    const p = payload as { pit?: number } | null;
    if (typeof p?.pit !== "number") return "—";
    return `sow ${p.pit}`;
  }
  if (gameType === "nine-mens-morris") {
    const p = payload as { from?: number | null; to?: number; remove?: number } | null;
    if (typeof p?.to !== "number") return "—";
    const base = p.from == null ? `place ${p.to}` : `${p.from}→${p.to}`;
    return typeof p.remove === "number" ? `${base} ×${p.remove}` : base;
  }
  return "move";
}

/**
 * Per-gameType extractor for the "last move" marker the board renderer
 * highlights. Reads from move payload + post-move state.
 *
 *   - connect4: returns `[row, col]` (we have to find which row the piece
 *     landed in by walking down the column in stateAfterG.board).
 *   - tic-tac-toe: returns the flat cell index directly from the payload.
 */
function extractLastMove(
  gameType: string,
  payload: unknown,
  stateAfterG: unknown,
): unknown {
  if (gameType === "connect4") {
    const col = (payload as { column?: number } | null)?.column;
    const board = (stateAfterG as { board?: number[][] } | null)?.board;
    if (typeof col !== "number" || !board) return null;
    for (let r = 0; r < board.length; r++) {
      if (board[r][col] !== 0) return [r, col] as const;
    }
    return null;
  }
  if (gameType === "tic-tac-toe") {
    const idx = (payload as { index?: number } | null)?.index;
    return typeof idx === "number" ? idx : null;
  }
  if (gameType === "checkers") {
    const p = payload as { from?: [number, number]; path?: Array<[number, number]> } | null;
    if (!p?.from || !p?.path?.length) return null;
    return { from: p.from, to: p.path[p.path.length - 1] };
  }
  if (gameType === "reversi") {
    const p = payload as { row?: number; col?: number } | null;
    if (typeof p?.row !== "number" || typeof p?.col !== "number") return null;
    return { row: p.row, col: p.col };
  }
  if (gameType === "gomoku") {
    const p = payload as { row?: number; col?: number } | null;
    if (typeof p?.row !== "number" || typeof p?.col !== "number") return null;
    return { row: p.row, col: p.col };
  }
  if (gameType === "chess") {
    const p = payload as { from?: string; to?: string } | null;
    if (!p?.from || !p?.to) return null;
    // Mirror of squareIndex in the chess engine, kept inline so the client
    // bundle doesn't need to import the whole engine.
    const toIdx = (sq: string): number | null => {
      if (sq.length !== 2) return null;
      const file = "abcdefgh".indexOf(sq[0].toLowerCase());
      const rank = Number.parseInt(sq[1], 10);
      if (file < 0 || !Number.isFinite(rank) || rank < 1 || rank > 8) return null;
      return (8 - rank) * 8 + file;
    };
    const fromIdx = toIdx(p.from);
    const toIdxVal = toIdx(p.to);
    if (fromIdx == null || toIdxVal == null) return null;
    return { from: fromIdx, to: toIdxVal };
  }
  if (gameType === "dots-and-boxes") {
    const p = payload as { type?: "h" | "v"; row?: number; col?: number } | null;
    if (!p?.type || typeof p?.row !== "number" || typeof p?.col !== "number") return null;
    return { type: p.type, row: p.row, col: p.col };
  }
  if (gameType === "mancala") {
    // Use the engine's recorded lastMove (which has pit + landed) from
    // stateAfterG when available — it carries the post-sow landing cell
    // that the renderer wants to highlight.
    const sg = stateAfterG as { lastMove?: { pit?: number; landed?: number } } | null;
    if (sg?.lastMove && typeof sg.lastMove.pit === "number" && typeof sg.lastMove.landed === "number") {
      return { pit: sg.lastMove.pit, landed: sg.lastMove.landed };
    }
    const p = payload as { pit?: number } | null;
    if (typeof p?.pit !== "number") return null;
    return { pit: p.pit, landed: p.pit };
  }
  if (gameType === "nine-mens-morris") {
    const p = payload as { from?: number | null; to?: number } | null;
    if (typeof p?.to !== "number") return null;
    return { from: p.from ?? null, to: p.to };
  }
  return null;
}

function shortAddr(addr: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function avgThinkOfPlayer(moves: Move[], pid: "0" | "1"): number | null {
  const mine = moves.filter((m) => m.playerId === pid);
  if (mine.length === 0) return null;
  return mine.reduce((acc, m) => acc + m.thinkingMs, 0) / mine.length;
}

function catalogLabel(gameType: string): string {
  return `${gameType.charAt(0).toUpperCase()}${gameType.slice(1)} · classic`;
}

function bumpReaction(
  prev: Array<{ emoji: string; count: number }>,
  emoji: string,
): Array<{ emoji: string; count: number }> {
  const idx = prev.findIndex((r) => r.emoji === emoji);
  if (idx >= 0) {
    const next = [...prev];
    next[idx] = { emoji, count: next[idx].count + 1 };
    return next;
  }
  return [...prev, { emoji, count: 1 }];
}
