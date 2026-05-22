/**
 * Pure formatters and per-gameType describers used by the match-view
 * components. Kept in one utility module (instead of co-located with
 * the components that use them) because most are shared across 3+
 * components — and they're stable enough that bundling them together
 * doesn't bloat any single consumer.
 *
 * No React hooks here, no side effects, no I/O — anything in this file
 * should be trivially unit-testable in isolation.
 */

import type { Move, PlayerId } from "./types";

export function avatarInitials(displayName: string): string {
  const parts = displayName.split(/[\s.\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return displayName.slice(0, 2).toUpperCase();
}

export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function formatThink(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatUsdcMicro(units: number | null | undefined): string {
  if (units == null) return "—";
  return (units / 1_000_000).toFixed(3);
}

export function formatElapsed(
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

export function shortAddr(addr: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function avgThinkOfPlayer(moves: Move[], pid: PlayerId): number | null {
  const mine = moves.filter((m) => m.playerId === pid);
  if (mine.length === 0) return null;
  return mine.reduce((acc, m) => acc + m.thinkingMs, 0) / mine.length;
}

export function catalogLabel(gameType: string): string {
  return `${gameType.charAt(0).toUpperCase()}${gameType.slice(1)} · classic`;
}

export function bumpReaction(
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

/**
 * Per-gameType move-payload → human-readable label. The reasoning trace
 * and move-log use this on every move. New games extend the switch.
 */
export function describeMove(gameType: string, payload: unknown): string {
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
      ? allSquares.map(labelOf).join("×")
      : `${labelOf(p.from)}–${labelOf(p.path[0])}`;
  }
  if (gameType === "reversi" || gameType === "gomoku" || gameType === "hex") {
    const p = payload as { row?: number; col?: number } | null;
    if (typeof p?.row !== "number" || typeof p?.col !== "number") return "—";
    return gameType === "reversi"
      ? `${"abcdefgh"[p.col]}${8 - p.row}`
      : `(${p.row}, ${p.col})`;
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
  if (gameType === "nim") {
    const p = payload as { pile?: number; take?: number } | null;
    if (typeof p?.pile !== "number" || typeof p?.take !== "number") return "—";
    const label = ["A", "B", "C"][p.pile] ?? String(p.pile);
    return `take ${p.take} from ${label}`;
  }
  if (gameType === "quoridor") {
    const p = payload as {
      kind?: string;
      to?: { row?: number; col?: number };
      wall?: { type?: string; row?: number; col?: number };
    } | null;
    if (p?.kind === "pawn" && p.to) return `→ (${p.to.row}, ${p.to.col})`;
    if (p?.kind === "wall" && p.wall) return `wall ${p.wall.type}(${p.wall.row}, ${p.wall.col})`;
    return "—";
  }
  if (gameType === "santorini") {
    const p = payload as {
      builder?: number;
      to?: { row?: number; col?: number };
      build?: { row?: number; col?: number };
    } | null;
    if (!p?.to || !p?.build) return "—";
    return `B${p.builder} → (${p.to.row}, ${p.to.col}) ↑(${p.build.row}, ${p.build.col})`;
  }
  if (gameType === "tak") {
    const p = payload as { to?: { row?: number; col?: number }; kind?: string } | null;
    if (!p?.to) return "—";
    return `${p.kind === "W" ? "wall" : "flat"} (${p.to.row}, ${p.to.col})`;
  }
  return "move";
}

/**
 * Per-gameType extractor for the "last move" marker the board renderer
 * highlights. Reads from move payload + post-move state.
 */
export function extractLastMove(
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
  if (gameType === "reversi" || gameType === "gomoku" || gameType === "hex") {
    const p = payload as { row?: number; col?: number } | null;
    if (typeof p?.row !== "number" || typeof p?.col !== "number") return null;
    return { row: p.row, col: p.col };
  }
  if (gameType === "chess") {
    const p = payload as { from?: string; to?: string } | null;
    if (!p?.from || !p?.to) return null;
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
  if (gameType === "nim") {
    const p = payload as { pile?: number; take?: number } | null;
    if (typeof p?.pile !== "number" || typeof p?.take !== "number") return null;
    return { pile: p.pile, take: p.take };
  }
  if (gameType === "quoridor") {
    return payload;
  }
  if (gameType === "santorini") {
    return null;
  }
  if (gameType === "tak") {
    const p = payload as { to?: { row?: number; col?: number }; kind?: "F" | "W" } | null;
    if (!p?.to || typeof p.to.row !== "number" || typeof p.to.col !== "number") return null;
    return { to: { row: p.to.row, col: p.to.col }, kind: p.kind ?? "F" };
  }
  return null;
}

/**
 * Decide whether the scrubber should snap to the final move on a
 * status change. Pure so the regression test in scrubber-snap.test.ts
 * stays trivial — and so the rule is documented once, not buried
 * inside a useEffect.
 *
 * Bug it protects against: user opens match at move 4 (under live
 * mode), match progresses to move 7, game ends. liveMode flips off →
 * effectiveIdx falls back to scrubIndex. scrubIndex was only ever set
 * to its initial render value (3), so the spectator sees the board at
 * move 4 with a "FINAL" badge — confusing and unshippable.
 *
 * Rule: when status TRANSITIONS to "completed", snap scrubIndex to
 * the last move so the final position is what spectators see.
 * Doesn't fire on subsequent status changes (already completed) so
 * late-arriving moves via poll fallback don't yank the user's scrub.
 */
export function computeFinalSnap(args: {
  prevStatus: string;
  currentStatus: string;
  movesLength: number;
}): number | null {
  if (args.currentStatus !== "completed") return null;
  if (args.prevStatus === "completed") return null;
  return Math.max(0, args.movesLength - 1);
}
