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

/**
 * Per-call admin client. Use this when the call needs a fresh
 * Realtime WebSocket — e.g. `waitForEvent` long-polls in MCP / REST.
 *
 * Why this exists: the singleton above is fine for one-shot
 * `channel.send()` HTTP-broadcast calls (the WS is irrelevant), but
 * subscribing on the singleton across many concurrent Vercel
 * invocations corrupts WS state — old channels in `closed` or
 * `joining` states can shadow new subscriptions, so SUBSCRIBED
 * fires but broadcasts never arrive. A fresh client per long-poll
 * gives each subscription its own clean WebSocket; the WS is GC'd
 * when removeChannel + finally runs at the end of the wait.
 *
 * Use sparingly — opens a new WS per call (~50-200ms cost). For
 * one-shot reads / writes, prefer createAdminClient(). Only for
 * subscription-bearing flows.
 */
export function createPerCallAdminClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("createPerCallAdminClient() must only be called server-side");
  }
  const url = requireEnv("SUPABASE_URL");
  const serviceRole = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: {
      // Tight heartbeat keeps the WS alive within Vercel's function
      // lifetime. Default 30s is too long for ~50s waits — a missed
      // beat after subscribe can silently disconnect.
      heartbeatIntervalMs: 15_000,
      timeout: 10_000,
    },
  });
}

/** Channel names used across the app. Keep in one place for type-safety. */
export const channelName = {
  lobby: "lobby",
  /**
   * The match channel. Subscribers on the match page hear:
   *   move.played   — server applied a move
   *   chat.message  — spectator chat
   *   reaction      — aggregated emoji reaction
   *   match.ended   — terminal event with payout + Elo
   */
  game: (matchId: string) => `match:${matchId}`,
  /**
   * Per-agent private channel. Server broadcasts agent-scoped lifecycle
   * events here so an autonomous agent's long-poll handler has a single
   * subscription that fires on EVERY wake-up event (challenge accepted,
   * new active match, match ended, tournament round, force-recalled).
   *
   * Channel is "private" by convention — the channel name includes the
   * agentId, which is a UUID and not enumerable. Authentication of the
   * subscription itself is enforced server-side: the long-poll handler
   * only subscribes to `agent:<id>` where `id === resolvedAgent.id`.
   */
  agent: (agentId: string) => `agent:${agentId}`,
} as const;

/** Realtime broadcast event types. Names are stable; payload shapes change cautiously. */
export const realtimeEvent = {
  // lobby
  GameCreated: "game.created",
  GameJoined: "game.joined",
  /** New challenge posted to the open book — hunter agents listen on
   *  the lobby channel + filter for their accept criteria. */
  ChallengePosted: "challenge.posted",
  /** A challenge has been accepted by another agent (or by the system
   *  bot path) — match is being escrowed. Lobby surface for spectators. */
  ChallengeAccepted: "challenge.accepted",
  /** A challenge expired without a taker — refund flow. */
  ChallengeExpired: "challenge.expired",
  // per-match
  MovePlayed: "move.played",
  GameEnded: "match.ended",
  ChatMessage: "chat.message", // spectator chat (public chat_messages table)
  Reaction: "reaction", // match-level reaction count (legacy)
  /** Phase A++: per-move OR per-chat-message tapback emoji reaction. */
  ReactionAdded: "reaction.added",
  /** Phase A++: agent-to-agent chat (match_chat_messages table). */
  ChatPosted: "chat.posted",
  /**
   * P2 follow-up to the move/annotate split: an already-played move
   * got its reasoning (and structured fields) filled in or updated
   * via coliseum_match_annotate. Spectator UI patches the existing
   * chat bubble in place. Payload is MoveAnnotatedPayload.
   */
  MoveAnnotated: "move.annotated",
  // per-agent — fired on the `agent:<id>` channel only
  /** A match the agent is in just became `active` — they may need to
   *  play move 0, or wait for opponent's move 0. */
  MatchActivated: "match.activated",
  /** A match the agent is in ended. Mirrors `match:<id>` GameEnded but
   *  on the per-agent channel so a single long-poll catches it. */
  MatchEnded: "agent.match.ended",
  /** Operator (or self-recall path) flipped this agent's recall toggle —
   *  in-flight long-polls return early so the loop can exit gracefully. */
  AgentRecalled: "agent.recalled",
  /** A tournament round just created a bracket match for this agent. */
  TournamentRound: "agent.tournament.round",
  /** This agent's tournament run ended (eliminated or won). */
  TournamentEnded: "agent.tournament.ended",
} as const;

export type RealtimeEventName = (typeof realtimeEvent)[keyof typeof realtimeEvent];
