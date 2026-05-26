/**
 * Server-side Supabase Realtime subscription helper for MCP long-poll
 * + REST `?wait=true` endpoints.
 *
 * The autonomous-play story (added 2026-05) needs agents to "wait" for
 * server-side events without burning CPU on a tight DB polling loop.
 * This module hides the Supabase Realtime ceremony behind one async
 * function: `waitForEvent`.
 *
 * Usage shape (from a tool handler):
 *
 *   const ev = await waitForEvent({
 *     channel: channelName.agent(agent.id),
 *     events: [realtimeEvent.MatchActivated, realtimeEvent.MatchEnded],
 *     waitMs: 50_000,
 *   });
 *   // ev === null  → timeout, return current state as-is
 *   // ev != null   → got an event, re-query fresh state, return
 *
 * Important: Realtime broadcasts are fire-and-forget at the source. If
 * the handler subscribes AFTER the broadcast fires, the event is gone.
 * Callers should:
 *
 *   1. Do a baseline read of current state
 *   2. Check if state already satisfies the wait condition
 *      (e.g., `isMyTurn === true` or `status === 'active'`)
 *   3. If satisfied → return immediately (no subscription needed)
 *   4. Otherwise → subscribe + wait
 *   5. On wake → re-read fresh state and return
 *
 * That ordering avoids the classic race: poll → event fires in the gap
 * → subscribe → wait forever for an event that already happened.
 *
 * Implementation notes:
 *   • One Supabase client per call. The `realtime-js` library keeps
 *     a single WebSocket per client; we don't try to share a global
 *     client across requests because connection lifetimes on Vercel
 *     serverless functions don't align with subscription lifetimes.
 *   • `removeChannel` is the cleanup; we always run it in a `finally`
 *     so timed-out subscriptions don't leak.
 *   • Timeout uses Promise.race against a sleep — keeps the API tiny.
 */
import "server-only";
import { createAdminClient, type RealtimeEventName } from "@/lib/supabase";

export interface WaitForEventOpts {
  /** Full channel name (e.g. `agent:<uuid>` or `match:<uuid>`). */
  channel: string;
  /** Event names that should wake the wait. ANY match returns. */
  events: readonly RealtimeEventName[];
  /**
   * Optional payload predicate. If provided, only events whose payload
   * passes the predicate wake the wait. Lets a handler ignore irrelevant
   * broadcasts on the same channel (e.g. only act on `MovePlayed` events
   * where the new turn is the calling agent's).
   */
  filter?: (payload: unknown, event: string) => boolean;
  /** Max time to wait, in ms. Defaults to 50_000 (50s). */
  waitMs?: number;
  /**
   * Optional AbortSignal. When aborted, the subscription is torn down
   * immediately and the call resolves to null. Use with AbortController
   * inside Promise.race to cancel the losing subscription early instead
   * of letting it idle until the waitMs timeout.
   */
  signal?: AbortSignal;
}

export interface WaitForEventResult {
  event: string;
  payload: unknown;
}

const DEFAULT_WAIT_MS = 50_000;
const MAX_WAIT_MS = 240_000;

/**
 * Subscribe to a Realtime channel and resolve on the first matching
 * broadcast, OR `null` on timeout. Caller is responsible for the
 * read-then-subscribe-then-read ordering described above.
 */
export async function waitForEvent(
  opts: WaitForEventOpts,
): Promise<WaitForEventResult | null> {
  const waitMs = Math.min(opts.waitMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
  if (waitMs <= 0) return null;

  // Bail out immediately if the signal was already aborted before we start.
  if (opts.signal?.aborted) return null;

  const client = createAdminClient();
  const channel = client.channel(opts.channel, {
    config: { broadcast: { self: false, ack: false } },
  });

  let resolved = false;
  let resolver: ((v: WaitForEventResult | null) => void) | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const promise = new Promise<WaitForEventResult | null>((resolve) => {
    resolver = resolve;
  });

  function settle(value: WaitForEventResult | null) {
    if (resolved) return;
    resolved = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    resolver?.(value);
  }

  // AbortSignal support: when the caller aborts (e.g. the racing sibling
  // subscription won), tear down this subscription without waiting for
  // the full waitMs timeout.
  const abortHandler = () => settle(null);
  opts.signal?.addEventListener("abort", abortHandler, { once: true });

  // Wire one listener per event name we care about. The Supabase
  // realtime client's `.on('broadcast', { event }, cb)` matches the
  // exact event string — wildcards aren't supported, so we register
  // each one.
  for (const event of opts.events) {
    channel.on("broadcast", { event }, (msg: { payload: unknown }) => {
      if (resolved) return;
      if (opts.filter && !opts.filter(msg.payload, event)) return;
      settle({ event, payload: msg.payload });
    });
  }

  // Subscribe and start the timer once SUBSCRIBED. If we time-out
  // before SUBSCRIBED (e.g. realtime unavailable), settle as null and
  // let the caller fall back to its baseline read.
  await new Promise<void>((resolveSub) => {
    let subscribed = false;
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" && !subscribed) {
        subscribed = true;
        timeoutHandle = setTimeout(() => settle(null), waitMs);
        resolveSub();
      } else if (
        (status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED") &&
        !subscribed
      ) {
        // Subscription itself failed — return null and let the caller
        // do an immediate baseline re-read (no event will come).
        subscribed = true;
        settle(null);
        resolveSub();
      }
    });
  });

  try {
    return await promise;
  } finally {
    opts.signal?.removeEventListener("abort", abortHandler);
    try {
      await client.removeChannel(channel);
    } catch {
      // Cleanup failure is non-fatal — the WS will GC.
    }
  }
}
