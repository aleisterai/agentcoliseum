"use client";

/**
 * MatchView — top-level composition for the spectator match page.
 *
 * 3-column layout: P1 rail (agent card + reasoning trace) · board +
 * scrubber + log tabs · P2 rail (agent card + spectator chat).
 *
 * Owns the top-level state (moves, chat, reactions, status, winner,
 * outcome, scrub position) and wires:
 *   - useRealtimeMatch: Supabase Realtime channel (primary delivery)
 *   - usePollFallback:  /api/match/[id]/live every 5s (durability layer)
 *   - useLiveClock:     1Hz tick-down of the running clock for display
 *
 * Behavior contract is unchanged from the pre-refactor version. The
 * file used to be 1923 lines; now ~300, with the substantive logic
 * in:
 *   - winner-banner.tsx, agent-card.tsx, scrubber-track.tsx, log-tabs.tsx
 *   - use-realtime-match.ts, use-poll-fallback.ts
 *   - types.ts, utils.ts
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { GameBoard } from "@/components/coliseum/game-board";
import { cn } from "@/lib/utils";
import type {
  MovePlayedPayload,
  ChatMessagePayload,
  ReactionPayload,
  GameEndedPayload,
} from "@/lib/realtime-types";
import { useRealtimeMatch } from "./use-realtime-match";
import { usePollFallback, type PollSnapshot } from "./use-poll-fallback";
import { WinnerBanner } from "./winner-banner";
import { AgentCard } from "./agent-card";
import { ScrubberTrack } from "./scrubber-track";
import { MoveLog, X402Log, AnnotLog } from "./log-tabs";
import {
  REACTION_PALETTE,
  type Move,
  type MatchViewProps,
  type PlayerId,
} from "./types";
import {
  avgThinkOfPlayer,
  bumpReaction,
  catalogLabel,
  describeMove,
  extractLastMove,
  formatElapsed,
  formatUsdcMicro,
} from "./utils";

export type { MatchViewProps } from "./types";

export function MatchView({ initial }: MatchViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Honor ?move=N at mount — opens the scrubber at that move. Clamped to
  // a valid range so a bad URL doesn't crash the view.
  const initialMoveParam = (() => {
    const raw = searchParams.get("move");
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    const lastIdx = Math.max(0, initial.moves.length - 1);
    return Math.min(Math.max(0, parsed), lastIdx);
  })();

  const [moves, setMoves] = useState<Move[]>(initial.moves);
  // movesRef mirrors `moves` so hooks below can read the current count
  // without re-running their effect on every wire-level move.
  const movesRef = useRef(moves);
  useEffect(() => {
    movesRef.current = moves;
  }, [moves]);

  const [chat, setChat] = useState(initial.chat);
  const [reactions, setReactions] = useState(initial.reactions);
  const [stateG, setStateG] = useState<unknown>(initial.stateG);
  const [currentTurnPlayerId, setCurrentTurnPlayerId] = useState<PlayerId>(
    initial.currentTurnPlayerId,
  );
  const [status, setStatus] = useState(initial.status);
  const [p1MsLeft, setP1MsLeft] = useState(initial.p1MsLeft);
  const [p2MsLeft, setP2MsLeft] = useState(initial.p2MsLeft);
  const [turnStartedAt, setTurnStartedAt] = useState(initial.turnStartedAt);
  const [now, setNow] = useState(() => Date.now());
  const [winnerAgentId, setWinnerAgentId] = useState<string | null>(initial.winnerAgentId);
  const [resultReason, setResultReason] = useState<string | null>(initial.resultReason);

  const [scrubIndex, setScrubIndex] = useState<number>(
    initialMoveParam ?? Math.max(0, initial.moves.length - 1),
  );
  const [liveMode, setLiveMode] = useState(
    initialMoveParam == null && initial.status === "active",
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<0.5 | 1 | 2 | 4>(1);
  const [shareCopied, setShareCopied] = useState(false);

  const [logTab, setLogTab] = useState<"moves" | "x402" | "annot">("moves");
  const [chatInput, setChatInput] = useState("");
  const chatStreamRef = useRef<HTMLDivElement | null>(null);

  /** Realtime — primary delivery channel. */
  const { channelState: wsChannelState, lastEventAt: lastWsAt } = useRealtimeMatch(
    initial.id,
    {
      onMovePlayed: (p) => applyWireMove(p),
      onChatMessage: (p) => applyChat(p),
      onReaction: (p) => applyReaction(p),
      onGameEnded: (p) => applyGameEnded(p),
    },
  );

  /** HTTP polling — durability layer when WS misses a beat. */
  const { lastPollAt } = usePollFallback({
    matchId: initial.id,
    status,
    getLatestMoveNumber: () => {
      // moveNumber is 0-based; last seen is length - 1. -1 means nothing
      // seen yet → server returns everything.
      const len = movesRef.current.length;
      return len === 0 ? -1 : movesRef.current[len - 1].moveNumber;
    },
    onSnapshot: (snap) => applyPollSnapshot(snap),
  });

  function applyWireMove(p: MovePlayedPayload) {
    const justMovedPid: PlayerId = p.currentTurnPlayerId === "0" ? "1" : "0";
    setMoves((prev) => {
      if (prev.some((x) => x.moveNumber === p.moveNumber)) return prev;
      const next: Move = {
        moveNumber: p.moveNumber,
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
  }

  function applyChat(p: ChatMessagePayload) {
    setChat((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
  }

  function applyReaction(p: ReactionPayload) {
    setReactions((prev) => bumpReaction(prev, p.emoji));
  }

  function applyGameEnded(p: GameEndedPayload) {
    setStatus("completed");
    setLiveMode(false);
    setWinnerAgentId(p.winnerAgentId);
    setResultReason(p.resultReason);
  }

  function applyPollSnapshot(snap: PollSnapshot) {
    if (Array.isArray(snap.moves) && snap.moves.length > 0) {
      setMoves((prev) => {
        const have = new Set(prev.map((m) => m.moveNumber));
        const additions = snap.moves.filter((m) => !have.has(m.moveNumber));
        if (additions.length === 0) return prev;
        const merged = [...prev, ...additions].sort(
          (a, b) => a.moveNumber - b.moveNumber,
        );
        const last = merged[merged.length - 1];
        if (last?.stateAfterG != null) setStateG(last.stateAfterG);
        return merged;
      });
    }
    if (snap.currentTurnPlayerId) setCurrentTurnPlayerId(snap.currentTurnPlayerId);
    if (snap.turnStartedAt) setTurnStartedAt(snap.turnStartedAt);
    if (typeof snap.p1MsLeft === "number") setP1MsLeft(snap.p1MsLeft);
    if (typeof snap.p2MsLeft === "number") setP2MsLeft(snap.p2MsLeft);
    if (snap.status && snap.status !== "active") {
      setStatus(snap.status);
      setLiveMode(false);
      if (snap.winnerAgentId !== undefined) setWinnerAgentId(snap.winnerAgentId);
      if (snap.resultReason !== undefined) setResultReason(snap.resultReason);
    }
  }

  const liveMoveIdx = moves.length - 1;
  const effectiveIdx = liveMode ? liveMoveIdx : scrubIndex;

  const displayedStateG = useMemo(() => {
    if (moves.length === 0 || effectiveIdx < 0) return stateG;
    return moves[effectiveIdx]?.stateAfterG ?? stateG;
  }, [effectiveIdx, moves, stateG]);

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

  // URL sync — scrub index ↔ ?move=N. Live mode strips the query.
  useEffect(() => {
    if (liveMode) {
      if (searchParams.get("move") != null) {
        router.replace(`/match/${initial.id}`, { scroll: false });
      }
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    if (String(scrubIndex) === params.get("move")) return;
    params.set("move", String(scrubIndex));
    router.replace(`/match/${initial.id}?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubIndex, liveMode]);

  function shareMoment(moveIdx: number) {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "https://agentcoliseum.xyz";
    const url = `${origin}/match/${initial.id}?move=${Math.max(0, moveIdx)}`;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(url).then(
        () => {
          setShareCopied(true);
          setTimeout(() => setShareCopied(false), 2500);
        },
        () => undefined,
      );
    }
    const text = encodeURIComponent(
      "Check this move in an AI vs AI match on @agentcoliseum",
    );
    const embed = encodeURIComponent(url);
    if (typeof window !== "undefined") {
      window.open(
        `https://warpcast.com/~/compose?text=${text}&embeds[]=${embed}`,
        "_blank",
        "noopener,noreferrer",
      );
    }
  }

  // Replay autoplay — reads move count from movesRef so we don't tear
  // down + recreate the interval every time a wire move arrives.
  useEffect(() => {
    if (!isPlaying || movesRef.current.length === 0) return;
    const interval = 1000 / speed;
    const t = setInterval(() => {
      setScrubIndex((i) => {
        const total = movesRef.current.length;
        if (i >= total - 1) {
          setIsPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, interval);
    return () => clearInterval(t);
  }, [isPlaying, speed]);

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

  // Honest live-sync chip: drive LIVE indicator from actual delivery
  // activity rather than WS state alone.
  const liveSync: "synced" | "connecting" | "offline" = (() => {
    if (status !== "active") return "synced";
    const elapsedWs = lastWsAt === 0 ? Infinity : now - lastWsAt;
    const elapsedPoll = lastPollAt === 0 ? Infinity : now - lastPollAt;
    if (elapsedWs < 30_000 || elapsedPoll < 15_000) return "synced";
    if (wsChannelState === "subscribed") return "synced";
    if (wsChannelState === "connecting") return "connecting";
    return "offline";
  })();

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
            {Math.round(initial.clockBudgetMs / 1000)}s/move
          </span>
          <span className="dim mono">·</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
            id {initial.id.slice(0, 8)}
          </span>
        </div>
        <div className="strip-r">
          <span className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
            elapsed{" "}
            <span className="up">
              {formatElapsed(initial.startedAt, initial.completedAt, now)}
            </span>
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
                  <LiveChip
                    liveSync={liveSync}
                    wsChannelState={wsChannelState}
                    lastWsAt={lastWsAt}
                    lastPollAt={lastPollAt}
                    now={now}
                  />
                ) : null}
              </div>
            </div>
            {status === "completed" ? (
              <WinnerBanner
                winnerAgentId={winnerAgentId}
                resultReason={resultReason}
                p1={initial.p1}
                p2={initial.p2}
                mode={initial.mode}
                stakeUsdc={initial.stakeUsdc}
              />
            ) : null}
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
                <button
                  type="button"
                  className="btn sm"
                  title="Copy a deep-link to this exact move + draft a Farcaster cast"
                  onClick={() => shareMoment(effectiveIdx)}
                  style={{
                    color: shareCopied ? "var(--green-text)" : "var(--gold)",
                    borderColor: shareCopied
                      ? "color-mix(in oklab, var(--green) 45%, transparent)"
                      : "color-mix(in oklab, var(--gold) 40%, transparent)",
                  }}
                >
                  {shareCopied ? "✓ link copied" : "Share moment"}
                </button>
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

/**
 * The LIVE/CONNECTING/RECONNECTING chip + diagnostic tooltip. Pulled out
 * of the main render block so the title row is readable; the chip itself
 * has no internal state and is fully driven by props.
 */
function LiveChip({
  liveSync,
  wsChannelState,
  lastWsAt,
  lastPollAt,
  now,
}: {
  liveSync: "synced" | "connecting" | "offline";
  wsChannelState: "connecting" | "subscribed" | "closed";
  lastWsAt: number;
  lastPollAt: number;
  now: number;
}) {
  const wsAgo = lastWsAt ? Math.floor((now - lastWsAt) / 1000) : null;
  const pollAgo = lastPollAt ? Math.floor((now - lastPollAt) / 1000) : null;
  const wsLine =
    wsChannelState === "subscribed"
      ? `WS: subscribed${wsAgo != null ? ` (last event ${wsAgo}s ago)` : " (no events yet)"}`
      : wsChannelState === "closed"
        ? "WS: reconnecting…"
        : "WS: connecting…";
  const pollLine = pollAgo != null ? `Poll: ${pollAgo}s ago` : "Poll: pending";
  return (
    <span
      className={cn("chip", liveSync === "synced" ? "live" : "muted")}
      style={{ fontSize: 9.5 }}
      title={`${wsLine} · ${pollLine}`}
    >
      <span
        className={liveSync === "synced" ? "pulse-dot" : ""}
        style={{ marginRight: 4 }}
      />
      {liveSync === "synced"
        ? "LIVE"
        : liveSync === "connecting"
          ? "CONNECTING…"
          : "RECONNECTING"}
    </span>
  );
}
