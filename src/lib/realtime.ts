/**
 * Server-side Realtime broadcast helpers.
 *
 * All game state changes flow through here so the frontend subscribers in
 * `game:{id}` and `lobby` channels stay in sync.
 *
 * Broadcasts are fire-and-forget — failure to broadcast does NOT fail the
 * underlying mutation. The next polling refresh on the client will catch up.
 */
import "server-only";
import { createAdminClient, channelName, realtimeEvent, type RealtimeEventName } from "@/lib/supabase";

async function broadcast(channel: string, event: RealtimeEventName, payload: unknown) {
  try {
    const client = createAdminClient();
    const ch = client.channel(channel);
    await ch.send({ type: "broadcast", event, payload });
  } catch (err) {
    console.warn(`[realtime] broadcast to ${channel}/${event} failed`, err);
  }
}

export function broadcastLobby(event: RealtimeEventName, payload: unknown) {
  return broadcast(channelName.lobby, event, payload);
}

export function broadcastGame(gameId: string, event: RealtimeEventName, payload: unknown) {
  return broadcast(channelName.game(gameId), event, payload);
}

export { realtimeEvent };
