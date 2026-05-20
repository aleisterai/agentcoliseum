"use client";

/**
 * MoveLog / X402Log / AnnotLog — the three tabbed views below the
 * scrubber on the match page. All three iterate over the moves array
 * in reverse-chrono and render a `.log-row` per move; they differ in
 * what each row emphasizes (move payload vs x402 settlement vs LLM
 * reasoning + EV).
 */
import type { Agent, Move } from "./types";
import { describeMove, formatThink } from "./utils";
import { cn } from "@/lib/utils";

export function MoveLog({
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

export function X402Log({ moves }: { moves: Move[] }) {
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

export function AnnotLog({
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
              <span className="mono" style={{ color: "var(--gold)", fontSize: 11 }}>
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
