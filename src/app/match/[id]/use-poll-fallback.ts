/**
 * usePollFallback — hits /api/match/[id]/live every 5s to catch any
 * MovePlayed broadcasts the WS missed (backgrounded tab, dropped
 * frames, Realtime REST-fallback hiccup, etc).
 *
 * Reads moveCount from a ref so the interval doesn't tear down + recreate
 * on every new move. The previous implementation had moves.length in the
 * effect dep array and thrashed under bot load (~6 moves/sec across
 * matches restarted the polling timer ~6 times/sec).
 *
 * Returns:
 *   - `lastPollAt`: epoch ms of last successful poll (0 if none). Use
 *     in combination with the WS hook's lastEventAt to render an
 *     honest LIVE/RECONNECTING chip.
 *
 * The hook does NOT own match state — it dispatches everything via the
 * `onSnapshot` callback the caller provides. The caller decides whether
 * to dedupe moves, update clocks, etc.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { MatchStatus, Move, PlayerId } from "./types";

export interface PollSnapshot {
  status: MatchStatus;
  currentTurnAgentId: string | null;
  currentTurnPlayerId: PlayerId;
  turnStartedAt: string;
  p1MsLeft: number;
  p2MsLeft: number;
  moveCount: number;
  winnerAgentId: string | null;
  resultReason: string | null;
  completedAt: string | null;
  lastMoveAt: string | null;
  /** Only moves newer than the `sinceMove` we asked for. May be empty. */
  moves: Move[];
}

export interface UsePollFallbackOptions {
  matchId: string;
  /** Stop polling once the match isn't active. */
  status: MatchStatus;
  /** Function the hook calls on every poll tick to learn the current
   *  count of seen moves. Should read from a useRef the parent updates
   *  on every setMoves so we don't force the effect to re-run when
   *  moves arrive. Return -1 if no moves seen yet. */
  getLatestMoveNumber: () => number;
  /** Called with each successful snapshot. */
  onSnapshot: (snap: PollSnapshot) => void;
  /** Poll interval in ms. 5000 by default. */
  intervalMs?: number;
}

export interface UsePollFallbackResult {
  /** Epoch ms of last successful poll, 0 if none yet. */
  lastPollAt: number;
}

export function usePollFallback({
  matchId,
  status,
  getLatestMoveNumber,
  onSnapshot,
  intervalMs = 5000,
}: UsePollFallbackOptions): UsePollFallbackResult {
  const [lastPollAt, setLastPollAt] = useState(0);
  // Pin both callbacks in refs so caller doesn't need to memoize them.
  const onSnapshotRef = useRef(onSnapshot);
  const getLatestMoveRef = useRef(getLatestMoveNumber);
  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
    getLatestMoveRef.current = getLatestMoveNumber;
  }, [onSnapshot, getLatestMoveNumber]);

  useEffect(() => {
    if (status !== "active") return;
    if (typeof window === "undefined") return;
    let cancelled = false;
    let inFlight = false;

    async function poll() {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const latestSeen = getLatestMoveRef.current();
        const res = await fetch(
          `/api/match/${matchId}/live?sinceMove=${latestSeen}`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled) return;
        const snap = (await res.json()) as PollSnapshot;
        if (cancelled) return;
        setLastPollAt(Date.now());
        onSnapshotRef.current(snap);
      } catch {
        /* network blip — next tick retries */
      } finally {
        inFlight = false;
      }
    }

    poll();
    const t = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [matchId, status, intervalMs]);

  return { lastPollAt };
}
