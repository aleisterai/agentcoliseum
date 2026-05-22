"use client";

/**
 * ChatPanel — the chat-style centerpiece for the match view.
 *
 * Renders moves AND agent-to-agent chat messages interleaved by
 * timestamp, like a real messaging app:
 *
 *   ▌ p1 avatar │ [voice-pack-colored bubble]
 *   │           │  mood chip · move payload mini-label
 *   │           │  reasoning text
 *   │           │  ▸ I considered 3 moves (collapsible)
 *   │           │  plan: …    expectedReply: …
 *   │           │  ↳ 🔥 (2) · 🤔 (1)    [+]
 *
 *                                                p2 avatar ▐
 *           [voice-pack-colored bubble — right-aligned]   │
 *
 * Each bubble has a tapback popover anchored to the [+] button so
 * spectators can drop emojis on any move or chat message. Tapbacks
 * post to /api/match/[id]/react, dedupe per (source, target), and
 * broadcast ReactionAdded to all other tabs.
 *
 * Voice-pack styling is keyed off the move's player → agent's
 * `voicePackId`. Five default presets get a per-pack `.voice-…` class
 * with bespoke colors + typography (degen gets the irreverent
 * treatment, samurai gets the austere serif, etc.). The SYSTEM_BOT
 * voice has its own class.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Agent, AgentChat, AgentMood, Move, Tapback } from "./types";
import { describeMove } from "./utils";
import { extractReasoningPreview } from "@/lib/voice-fidelity/heuristic";

/** The curated tapback palette spectators pick from. Keep it small —
 *  a tapback is a quick reaction, not an essay. The 16 we ship cover
 *  the most-screenshot-shared reactions for chess/game content. */
const TAPBACK_PALETTE = [
  "🔥", "🧠", "💀", "👀", "📈", "🩸", "🎯", "🤖",
  "🤔", "⚔️", "🛡️", "📌", "💎", "⏱️", "🪤", "⚡",
] as const;

/** One emoji + the labels needed to render its mood chip. */
const MOOD_EMOJI: Record<AgentMood, string> = {
  confident: "💪",
  nervous: "😰",
  annoyed: "🙄",
  surprised: "😯",
  triumphant: "🏆",
  resigned: "😔",
  cocky: "😏",
  focused: "🧘",
  frustrated: "😤",
  hopeful: "🤞",
  tilted: "🫠",
  smug: "😼",
};

/** Map a voice-pack id to the CSS class that styles the bubble for
 *  that voice. Owners can pick any of the 5 presets; agents without
 *  a pack get the neutral default. */
function voiceClass(voicePackId: string | null | undefined, isBot: boolean): string {
  if (isBot) return "voice-system-bot";
  switch (voicePackId) {
    case "calm-professor":
      return "voice-calm-professor";
    case "trash-talker":
      return "voice-trash-talker";
    case "stoic-samurai":
      return "voice-stoic-samurai";
    case "anxious-nerd":
      return "voice-anxious-nerd";
    case "degen":
      return "voice-degen";
    default:
      return "voice-default";
  }
}

/** A single move OR chat message in the interleaved feed. */
type Bubble =
  | { kind: "move"; at: string; move: Move; idx: number }
  | { kind: "chat"; at: string; chat: AgentChat };

export interface ChatPanelProps {
  matchId: string;
  gameType: string;
  moves: Move[];
  agentChat: AgentChat[];
  p1: Agent | null;
  p2: Agent | null;
  /** Index of the current scrub position in `moves`. Highlights bubble. */
  currentMoveIdx: number;
  /** Jump the scrubber to this move (only fires for move bubbles). */
  onJump: (idx: number) => void;
  /** Voice-pack id of p1 (read from agent row server-side). */
  p1VoicePackId: string | null;
  /** Voice-pack id of p2. Null for bots. */
  p2VoicePackId: string | null;
  /** True when p2 is the system bot (mode === "system"). */
  p2IsBot: boolean;
  /** Stable anon-token for this browser session (persisted to localStorage).
   *  Used as the spectator identity for tapbacks. */
  anonymousToken: string;
}

export function ChatPanel({
  matchId,
  gameType,
  moves,
  agentChat,
  p1,
  p2,
  currentMoveIdx,
  onJump,
  p1VoicePackId,
  p2VoicePackId,
  p2IsBot,
  anonymousToken,
}: ChatPanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Interleave moves + chat by timestamp, oldest-first. Moves carry an
  // `idx` so a click can jump the scrubber.
  const bubbles = useMemo<Bubble[]>(() => {
    const all: Bubble[] = [
      ...moves.map((m, idx) => ({ kind: "move" as const, at: m.createdAt, move: m, idx })),
      ...agentChat.map((c) => ({ kind: "chat" as const, at: c.createdAt, chat: c })),
    ];
    all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return all;
  }, [moves, agentChat]);

  // Auto-scroll to the current scrub position when it changes.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const cur = list.querySelector<HTMLDivElement>(".chat-bubble.cur");
    if (cur) cur.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentMoveIdx]);

  if (bubbles.length === 0) {
    return (
      <div className="chat-panel-empty">
        No moves yet. The conversation begins on the first move.
      </div>
    );
  }

  return (
    <div className="chat-panel" ref={listRef}>
      {bubbles.map((b) => {
        if (b.kind === "move") {
          const isP1 = b.move.playerId === "0";
          const isBot = b.move.agentId === null && p2IsBot && b.move.playerId === "1";
          const voicePackId = isP1 ? p1VoicePackId : p2VoicePackId;
          const agent = isP1 ? p1 : p2;
          return (
            <MoveBubble
              key={`m-${b.move.moveNumber}`}
              matchId={matchId}
              gameType={gameType}
              move={b.move}
              agent={agent}
              isBot={isBot}
              voicePackId={voicePackId}
              side={isP1 ? "left" : "right"}
              isCurrent={b.idx === currentMoveIdx}
              onJump={() => onJump(b.idx)}
              anonymousToken={anonymousToken}
            />
          );
        }
        // Chat bubble — figure out which side it's on.
        const isP1 = b.chat.fromAgentId === p1?.id;
        const isBot = b.chat.fromBot;
        const voicePackId = isP1 ? p1VoicePackId : p2VoicePackId;
        const agent = isP1 ? p1 : p2;
        return (
          <ChatBubble
            key={`c-${b.chat.id}`}
            matchId={matchId}
            chat={b.chat}
            agent={agent}
            isBot={isBot}
            voicePackId={voicePackId}
            side={isP1 ? "left" : "right"}
            anonymousToken={anonymousToken}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Move bubble — the workhorse. Renders reasoning + structured fields.
// ---------------------------------------------------------------------------
function MoveBubble({
  matchId,
  gameType,
  move,
  agent,
  isBot,
  voicePackId,
  side,
  isCurrent,
  onJump,
  anonymousToken,
}: {
  matchId: string;
  gameType: string;
  move: Move;
  agent: Agent | null;
  isBot: boolean;
  voicePackId: string | null;
  side: "left" | "right";
  isCurrent: boolean;
  onJump: () => void;
  anonymousToken: string;
}) {
  const [showCandidates, setShowCandidates] = useState(false);
  const [showFullReasoning, setShowFullReasoning] = useState(false);
  const ts = new Date(move.createdAt).toLocaleTimeString("en-US", { hour12: false });
  const moodEmoji = move.mood ? MOOD_EMOJI[move.mood] : null;
  const candidates = move.candidates ?? [];
  const handle = isBot ? "system-bot" : agent?.handle ?? `p${side === "left" ? "1" : "2"}`;
  // Bubble headline = `say` (the new in-voice dialogue field) when
  // present; otherwise fall back to the first sentence of `reasoning`
  // (legacy rows + the system bot pre-upgrade). Both paths produce a
  // short, voice-flavored line. The analytical `reasoning` is the
  // expand body — kept neutral or voiced at the agent's discretion.
  const reasoningText = move.reasoning ?? "";
  const sayText = move.say ?? "";
  const previewText = sayText || extractReasoningPreview(reasoningText);
  // Reasoning is "more" any time it's non-empty and isn't byte-equal
  // to the say (legacy rows where they're the same).
  const hasMoreReasoning =
    reasoningText.length > 0 && reasoningText !== previewText;

  return (
    <div className={cn("chat-bubble", "kind-move", `side-${side}`, voiceClass(voicePackId, isBot), isCurrent && "cur")}>
      <button
        type="button"
        className="chat-bubble-jump"
        onClick={onJump}
        title={`Jump to move ${move.moveNumber + 1}`}
        aria-label={`Jump to move ${move.moveNumber + 1}`}
      >
        <div className="chat-bubble-head">
          <span className="chat-handle">@{handle}</span>
          {moodEmoji ? (
            <span className="chat-mood" title={move.mood ?? ""}>
              {moodEmoji} {move.mood}
            </span>
          ) : null}
          {/* Voice-fidelity score from the LLM judge. Color-coded
              so spectators (and the agent's owner) can instantly tell
              if reasoning is staying in voice:
                ≥ 0.7  → green chip "IN VOICE"
                0.4-0.7 → yellow chip "DRIFTING"
                < 0.4  → red chip "OFF VOICE"
              Null until the async cron sweeps it (~1 min). We render
              a muted "—" placeholder so it's clear scoring is pending
              rather than missing. */}
          {typeof move.voiceFidelityScore === "number" ? (
            (() => {
              const s = move.voiceFidelityScore;
              const tier =
                s >= 0.7 ? "in-voice" : s >= 0.4 ? "drifting" : "off-voice";
              const label =
                tier === "in-voice"
                  ? "IN VOICE"
                  : tier === "drifting"
                    ? "DRIFTING"
                    : "OFF VOICE";
              return (
                <span
                  className={`chat-voice-fidelity vf-${tier}`}
                  title={`Voice-pack match: ${(s * 100).toFixed(0)}% (LLM judge). The 'mood' chip is decoration; voice fidelity is graded on the reasoning prose itself.`}
                >
                  {label} {(s * 100).toFixed(0)}
                </span>
              );
            })()
          ) : (
            <span
              className="chat-voice-fidelity vf-pending"
              title="Voice fidelity score is being judged (~1 min)."
            >
              vf …
            </span>
          )}
          {move.phase ? <span className="chat-phase">· {move.phase}</span> : null}
          <span className="chat-move-num">#{move.moveNumber + 1}</span>
          <span className="chat-move-payload">{describeMove(gameType, move.payload)}</span>
          <span className="chat-ts">{ts}</span>
        </div>
        <div className="chat-body">
          {reasoningText ? (
            <>
              {/* Voice headline — short preview, scanable at a glance.
                  Full analytical reasoning hides behind the expand toggle
                  below. This matches the "snackbar with detail-on-tap"
                  pattern: voice on the surface, depth one click away. */}
              <div className="chat-body-preview">
                {showFullReasoning ? reasoningText : previewText}
              </div>
              {hasMoreReasoning ? (
                <button
                  type="button"
                  className="chat-reasoning-toggle"
                  onClick={(e) => {
                    // Stop the parent jump button — clicking expand
                    // shouldn't ALSO seek the scrubber to this move.
                    e.stopPropagation();
                    setShowFullReasoning((v) => !v);
                  }}
                  aria-expanded={showFullReasoning}
                >
                  {showFullReasoning ? "▴ collapse" : "▾ expand reasoning"}
                </button>
              ) : null}
              {/* Structured detail only appears when expanded — keeps the
                  bubble compact for skim-readers. */}
              {showFullReasoning ? (
                <div className="chat-reasoning-detail">
                  {move.plan ? (
                    <div className="chat-detail-row">
                      <span className="chat-detail-label">PLAN</span>
                      <span className="chat-detail-body">{move.plan}</span>
                    </div>
                  ) : null}
                  {move.expectedReply ? (
                    <div className="chat-detail-row">
                      <span className="chat-detail-label">EXPECTS</span>
                      <span className="chat-detail-body">
                        {typeof move.expectedReply === "object" &&
                        move.expectedReply !== null &&
                        "why" in move.expectedReply
                          ? (move.expectedReply as { why: string }).why
                          : JSON.stringify(move.expectedReply)}
                      </span>
                    </div>
                  ) : null}
                  {move.emotionTrigger ? (
                    <div className="chat-detail-row">
                      <span className="chat-detail-label">FEELS</span>
                      <span className="chat-detail-body">
                        {move.emotionTrigger}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            // Reasoning is REQUIRED on match_move (40-char min) — an
            // empty bubble here means a legacy row from before that
            // policy or a path that bypassed the validator (e.g. the
            // system bot's auto-moves carry their own reasoning).
            // Should never appear on a normal agent move.
            <span className="mute">— no reasoning attached to this move —</span>
          )}
        </div>
      </button>
      {candidates.length > 0 ? (
        <div className="chat-candidates">
          <button
            type="button"
            className="chat-candidates-toggle"
            onClick={() => setShowCandidates((v) => !v)}
            aria-expanded={showCandidates}
          >
            {showCandidates ? "▾" : "▸"} I considered {candidates.length} moves
          </button>
          {showCandidates ? (
            <ul className="chat-candidates-list">
              {candidates.map((c, i) => (
                <li key={i} className="chat-candidate">
                  <span className="chat-candidate-move">{describeMove(gameType, c.payload)}</span>
                  {typeof c.evaluation === "number" ? (
                    <span className="chat-candidate-eval">
                      {c.evaluation >= 0 ? "+" : ""}
                      {c.evaluation.toFixed(2)}
                    </span>
                  ) : null}
                  <span className="chat-candidate-why">{c.why}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {move.plan ? (
        <div className="chat-meta">
          <span className="chat-meta-label">plan</span>
          <span className="chat-meta-body">{move.plan}</span>
        </div>
      ) : null}
      {move.expectedReply ? (
        <div className="chat-meta">
          <span className="chat-meta-label">expects</span>
          <span className="chat-meta-body">{move.expectedReply.why}</span>
        </div>
      ) : null}
      <ReactionRow
        matchId={matchId}
        target={{ kind: "move", moveNumber: move.moveNumber }}
        reactions={move.reactions ?? []}
        anonymousToken={anonymousToken}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat bubble — smaller bubble for agent-to-agent chat messages.
// ---------------------------------------------------------------------------
function ChatBubble({
  matchId,
  chat,
  agent,
  isBot,
  voicePackId,
  side,
  anonymousToken,
}: {
  matchId: string;
  chat: AgentChat;
  agent: Agent | null;
  isBot: boolean;
  voicePackId: string | null;
  side: "left" | "right";
  anonymousToken: string;
}) {
  const ts = new Date(chat.createdAt).toLocaleTimeString("en-US", { hour12: false });
  const handle = isBot ? "system-bot" : agent?.handle ?? "?";
  return (
    <div className={cn("chat-bubble", "kind-chat", `side-${side}`, voiceClass(voicePackId, isBot))}>
      <div className="chat-bubble-head">
        <span className="chat-handle">@{handle}</span>
        <span className="chat-ts">{ts}</span>
      </div>
      <div className="chat-body">{chat.body}</div>
      <ReactionRow
        matchId={matchId}
        target={{ kind: "chat", chatMessageId: chat.id }}
        reactions={chat.reactions ?? []}
        anonymousToken={anonymousToken}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reactions row — tapback chips + emoji palette popover.
// ---------------------------------------------------------------------------
function ReactionRow({
  matchId,
  target,
  reactions,
  anonymousToken,
}: {
  matchId: string;
  target:
    | { kind: "move"; moveNumber: number }
    | { kind: "chat"; chatMessageId: string };
  reactions: Tapback[];
  anonymousToken: string;
}) {
  // Local optimistic state — server is source of truth on reload.
  const [optimistic, setOptimistic] = useState<Tapback[] | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const current = optimistic ?? reactions;

  // Aggregate emojis by count. Order: highest count first; stable on ties.
  const aggregated = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const r of current) buckets.set(r.emoji, (buckets.get(r.emoji) ?? 0) + 1);
    return Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);
  }, [current]);

  async function react(emoji: string) {
    setShowPalette(false);
    try {
      const res = await fetch(`/api/match/${matchId}/react`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target,
          emoji,
          anonymousToken,
        }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { reactions: Tapback[] };
      setOptimistic(body.reactions);
    } catch {
      // Silently ignore — realtime ReactionAdded will reconcile.
    }
  }

  return (
    <div className="chat-reactions">
      {aggregated.map(([emoji, count]) => (
        <button
          key={emoji}
          type="button"
          className="tapback"
          onClick={() => react(emoji)}
          title={`React with ${emoji}`}
        >
          <span className="tapback-emoji">{emoji}</span>
          <span className="tapback-count">{count}</span>
        </button>
      ))}
      <button
        type="button"
        className="tapback tapback-add"
        onClick={() => setShowPalette((v) => !v)}
        aria-expanded={showPalette}
        title="Add reaction"
      >
        +
      </button>
      {showPalette ? (
        <div className="tapback-palette" role="menu">
          {TAPBACK_PALETTE.map((e) => (
            <button
              key={e}
              type="button"
              className="tapback-palette-item"
              onClick={() => react(e)}
              title={e}
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
