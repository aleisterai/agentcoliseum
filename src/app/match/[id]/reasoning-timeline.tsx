"use client";

/**
 * ReasoningTimeline — the "reasoning-primary" centerpiece for the match
 * view. Shows BOTH players' moves interleaved by move number, each item
 * carrying the move text, EV swing, and the agent's natural-language
 * reasoning. Used in place of the board when focus mode === "reasoning".
 *
 * Items are click-to-jump (same effect as clicking a row in the move log
 * tab — sets scrubIndex to that move). The current scrub position is
 * highlighted via the `.cur` class so the timeline tracks the scrubber.
 */
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Agent, Move, PlayerId } from "./types";
import { describeMove } from "./utils";

export interface ReasoningTimelineProps {
  gameType: string;
  moves: Move[];
  p1: Agent | null;
  p2: Agent | null;
  currentIdx: number;
  onJump: (idx: number) => void;
}

export function ReasoningTimeline({
  gameType,
  moves,
  p1,
  p2,
  currentIdx,
  onJump,
}: ReasoningTimelineProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll the current item into view when the scrubber moves to a
  // new index — keeps "what you're watching" visible without manual scroll.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const cur = list.querySelector<HTMLButtonElement>(".reason-item.cur");
    if (cur) cur.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentIdx]);

  if (moves.length === 0) {
    return (
      <div className="reasoning-stage-empty">
        No moves yet. Reasoning will appear here as the agents play.
      </div>
    );
  }

  return (
    <div className="reason-timeline" ref={listRef}>
      {moves.map((m, idx) => {
        const isP1 = m.playerId === "0";
        const handle = isP1 ? p1?.handle ?? "p1" : p2?.handle ?? "p2";
        const evText =
          m.evScore != null
            ? m.evScore >= 0
              ? `+${m.evScore.toFixed(2)}`
              : m.evScore.toFixed(2)
            : null;
        const evDown = m.evScore != null && m.evScore < 0;
        const ts = new Date(m.createdAt).toLocaleTimeString("en-US", {
          hour12: false,
        });
        const thinkSec =
          m.thinkingMs > 0 ? `${(m.thinkingMs / 1000).toFixed(1)}s` : null;
        return (
          <button
            type="button"
            key={m.moveNumber}
            className={cn(
              "reason-item",
              isP1 ? "p1" : "p2",
              idx === currentIdx && "cur",
            )}
            onClick={() => onJump(idx)}
            aria-label={`Jump to move ${m.moveNumber + 1}`}
          >
            <span className="reason-num">#{m.moveNumber + 1}</span>
            <span className="reason-body">
              <span className="reason-hd">
                <span className={cn("who", isP1 ? "p1" : "p2")}>@{handle}</span>
                <span className="move">{describeMove(gameType, m.payload)}</span>
                {evText ? (
                  <span className={cn("ev", evDown && "down")}>EV {evText}</span>
                ) : null}
                <span className="ts">{ts}</span>
              </span>
              <span
                className={cn("reason-text", !m.reasoning && "mute")}
              >
                {m.reasoning || "— agent did not return reasoning —"}
              </span>
            </span>
            {thinkSec ? <span className="reason-think">{thinkSec}</span> : <span />}
          </button>
        );
      })}
    </div>
  );
}

// Keep PlayerId import alive for downstream consumers; not used directly here
// but exporting from a typed module is cleaner than a side-effect declaration.
export type { PlayerId };
