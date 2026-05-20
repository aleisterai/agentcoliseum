/**
 * useRealtimeMatch — Supabase Realtime subscription for a single match,
 * with auto-resubscribe.
 *
 * Why a custom hook (not a library): Supabase's auto-reconnect doesn't
 * re-emit `SUBSCRIBED` for an existing channel object after a transient
 * CLOSED/CHANNEL_ERROR/TIMED_OUT. Without explicit removeChannel +
 * recreate, the chip pegs on RECONNECTING for the rest of the page
 * lifetime even after broadcasts resume. This hook implements the
 * self-healing dance.
 *
 * State exposed:
 *   - `channelState`: "connecting" | "subscribed" | "closed" — the raw
 *     WS status, used as a chip tiebreaker before any delivery arrives
 *   - `lastEventAt`: epoch ms of the last delivered MovePlayed (0 if none).
 *     Drive the LIVE/RECONNECTING chip from this + the polling timestamp,
 *     not from `channelState` alone (broadcasts can arrive on a brand-new
 *     channel before SUBSCRIBED is observed locally).
 *
 * Handlers (`on*`) are stable across renders — we capture them in a
 * ref so callers don't have to memoize.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { createPublicClient, channelName, realtimeEvent } from "@/lib/supabase";
import type {
  MovePlayedPayload,
  GameEndedPayload,
  ChatMessagePayload,
  ReactionPayload,
} from "@/lib/realtime-types";

export type RealtimeChannelState = "connecting" | "subscribed" | "closed";

export interface UseRealtimeMatchHandlers {
  onMovePlayed?: (p: MovePlayedPayload) => void;
  onChatMessage?: (p: ChatMessagePayload) => void;
  onReaction?: (p: ReactionPayload) => void;
  onGameEnded?: (p: GameEndedPayload) => void;
}

export interface UseRealtimeMatchResult {
  /** Raw WS channel state. */
  channelState: RealtimeChannelState;
  /** Epoch ms of the last MovePlayed delivered. 0 if none. */
  lastEventAt: number;
}

export function useRealtimeMatch(
  matchId: string,
  handlers: UseRealtimeMatchHandlers,
): UseRealtimeMatchResult {
  const [channelState, setChannelState] = useState<RealtimeChannelState>("connecting");
  const [lastEventAt, setLastEventAt] = useState(0);

  // Pin the latest handlers so the effect doesn't re-run when callers
  // re-create them inline.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      setChannelState("closed");
      return;
    }

    let cleanedUp = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    type SbClient = ReturnType<typeof createPublicClient>;
    type Channel = ReturnType<SbClient["channel"]>;
    let sb: SbClient | null = null;
    let ch: Channel | null = null;

    function join() {
      if (cleanedUp) return;
      try {
        sb = createPublicClient();
        const channel = sb.channel(channelName.game(matchId));
        ch = channel;

        channel.on("broadcast", { event: realtimeEvent.MovePlayed }, (e: { payload: unknown }) => {
          const p = e.payload as Partial<MovePlayedPayload>;
          // Guard: the client used to bail silently when these fields
          // drifted (publicState vs stateAfterG). Keep the same guard
          // — better to drop a malformed broadcast than corrupt state.
          if (p.moveNumber == null || p.stateAfterG == null) return;
          setLastEventAt(Date.now());
          handlersRef.current.onMovePlayed?.(p as MovePlayedPayload);
        });

        channel.on("broadcast", { event: realtimeEvent.ChatMessage }, (e: { payload: unknown }) => {
          handlersRef.current.onChatMessage?.(e.payload as ChatMessagePayload);
        });

        channel.on("broadcast", { event: realtimeEvent.Reaction }, (e: { payload: unknown }) => {
          handlersRef.current.onReaction?.(e.payload as ReactionPayload);
        });

        channel.on("broadcast", { event: realtimeEvent.GameEnded }, (e: { payload: unknown }) => {
          handlersRef.current.onGameEnded?.(e.payload as GameEndedPayload);
        });

        channel.subscribe((status) => {
          if (cleanedUp) return;
          if (status === "SUBSCRIBED") {
            setChannelState("subscribed");
            return;
          }
          if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setChannelState("closed");
            // Self-heal: drop the existing channel and rejoin with a 2s
            // backoff. Supabase's socket-level auto-reconnect doesn't
            // re-fire SUBSCRIBED for an existing channel object.
            if (sb && ch) sb.removeChannel(ch);
            ch = null;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(join, 2000);
            return;
          }
          setChannelState("connecting");
        });
      } catch {
        setChannelState("closed");
      }
    }

    join();
    return () => {
      cleanedUp = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sb && ch) sb.removeChannel(ch);
    };
  }, [matchId]);

  return { channelState, lastEventAt };
}
