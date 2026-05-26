/**
 * Server-side Realtime broadcast helpers.
 *
 * All game state changes flow through here so the frontend subscribers in
 * `game:{id}` and `lobby` channels stay in sync.
 *
 * History of this file:
 *   1. v1 — `client.channel(name).send({type:'broadcast', ...})` without
 *      ever subscribing. Supabase-js routes this through the REST
 *      Broadcast endpoint. Quietly failed in production: send() returns
 *      'ok' | 'timed out' | 'error' as a STRING (not a thrown exception),
 *      and the old try/catch swallowed everything. The Vercel smoke test
 *      at scripts/mcp-ws1-broadcast-e2e.ts (added 2026-05 alongside
 *      AGE-55) caught this — broadcasts logged success but
 *      `match_list(wait:true)` subscribers never woke.
 *   2. v2 (this file) — subscribe to the channel, wait for SUBSCRIBED,
 *      then send via WebSocket. Send response is checked and surfaced
 *      as a console.warn on anything other than 'ok'. Channel is torn
 *      down right after to avoid leaking sockets.
 *
 * Trade-off: each broadcast now costs one extra round-trip (subscribe
 * handshake, ~150-500ms). At our call volume (couple hundred broadcasts
 * per hour) this is fine. If it ever becomes a bottleneck, a connection
 * pool of pre-subscribed channels per channel-name would amortize it.
 */
import "server-only";
import { createAdminClient, channelName, realtimeEvent, type RealtimeEventName } from "@/lib/supabase";

const SUBSCRIBE_TIMEOUT_MS = 4_000;
const SEND_TIMEOUT_MS = 4_000;

async function broadcast(channel: string, event: RealtimeEventName, payload: unknown) {
  let ch: ReturnType<ReturnType<typeof createAdminClient>["channel"]> | null = null;
  try {
    const client = createAdminClient();
    ch = client.channel(channel, {
      config: { broadcast: { self: false, ack: true } },
    });

    // Wait for the channel to be SUBSCRIBED. The REST broadcast path
    // can silently fail under RLS or rate-limit conditions — going
    // through the WebSocket path requires a successful subscribe but
    // is more reliable.
    await new Promise<void>((resolve, reject) => {
      const tm = setTimeout(
        () => reject(new Error("subscribe timeout")),
        SUBSCRIBE_TIMEOUT_MS,
      );
      ch!.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(tm);
          resolve();
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          clearTimeout(tm);
          reject(new Error(`subscribe status: ${status}`));
        }
      });
    });

    // Send with ack so the Promise resolves to a status string we can
    // verify. ack:true on the channel config above + a hard timeout
    // catches the case where the broadcast queues forever.
    const result = await Promise.race([
      ch.send({ type: "broadcast", event, payload }),
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error("send timeout")),
          SEND_TIMEOUT_MS,
        ),
      ),
    ]);
    if (result !== "ok") {
      console.warn(
        `[realtime] broadcast to ${channel}/${event} returned non-ok: ${result}`,
      );
    }
  } catch (err) {
    console.warn(`[realtime] broadcast to ${channel}/${event} failed`, err);
  } finally {
    if (ch) {
      try {
        const client = createAdminClient();
        await client.removeChannel(ch);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export function broadcastLobby(event: RealtimeEventName, payload: unknown) {
  return broadcast(channelName.lobby, event, payload);
}

export function broadcastGame(gameId: string, event: RealtimeEventName, payload: unknown) {
  return broadcast(channelName.game(gameId), event, payload);
}

/**
 * Broadcast to the per-agent channel. Agent-scoped lifecycle events
 * (MatchActivated, MatchEnded, ChallengeAccepted-for-poster, recalled,
 * tournament round/ended) flow here so a single long-poll on
 * `agent:<id>` catches every wake-up that matters to one agent.
 *
 * The frontend doesn't subscribe to these channels — they exist purely
 * to wake the MCP `coliseum_match_list({ wait: true })` handler.
 */
export function broadcastAgent(agentId: string, event: RealtimeEventName, payload: unknown) {
  return broadcast(channelName.agent(agentId), event, payload);
}

export { realtimeEvent };
