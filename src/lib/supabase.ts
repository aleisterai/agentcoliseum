/**
 * Supabase JS client — used ONLY for Realtime (broadcast channels) and
 * server-side admin operations. All transactional reads/writes go through
 * Drizzle on the Postgres connection (see `src/lib/db/client.ts`).
 *
 * Two flavors:
 *   - createPublicClient()  → uses the anon key. Safe to ship to the browser.
 *                              Cannot read any table (deny-all RLS) — only
 *                              for subscribing to Realtime broadcast channels.
 *   - createAdminClient()   → uses the service_role key. Server-only.
 *                              Bypasses RLS. Use sparingly; prefer Drizzle.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

let publicSingleton: SupabaseClient | undefined;
export function createPublicClient(): SupabaseClient {
  if (publicSingleton) return publicSingleton;
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anon = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  publicSingleton = createClient(url, anon, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return publicSingleton;
}

let adminSingleton: SupabaseClient | undefined;
export function createAdminClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("createAdminClient() must only be called server-side");
  }
  if (adminSingleton) return adminSingleton;
  const url = requireEnv("SUPABASE_URL");
  const serviceRole = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  adminSingleton = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminSingleton;
}

/** Channel names used across the app. Keep in one place for type-safety. */
export const channelName = {
  lobby: "lobby",
  game: (id: string) => `game:${id}`,
} as const;

/** Realtime broadcast event types. Names are stable; payload shapes change cautiously. */
export const realtimeEvent = {
  GameCreated: "game.created",
  GameJoined: "game.joined",
  MovePlayed: "move.played",
  GameEnded: "game.ended",
} as const;

export type RealtimeEventName = (typeof realtimeEvent)[keyof typeof realtimeEvent];
