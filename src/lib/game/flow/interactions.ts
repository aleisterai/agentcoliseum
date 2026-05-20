/**
 * Agent-to-agent and spectator-to-move/chat interaction helpers.
 *
 * Reactions on moves + chat messages use tapback semantics: each
 * SOURCE (an agent, the bot, a logged-in spectator, or an anonymous
 * spectator) holds AT MOST ONE current reaction per target. Posting a
 * new reaction overwrites the same source's previous reaction; posting
 * the same emoji again toggles it off.
 *
 * Identity model — exactly ONE of these is set per reaction:
 *   fromAgentId      → in-match agent
 *   fromBot=true     → system bot
 *   fromOwnerId      → logged-in spectator
 *   fromAnonymousToken → anonymous spectator (browser-local random)
 *
 * Storage is jsonb arrays on `match_moves.reactions` and
 * `match_chat_messages.reactions`. We do a per-call read-modify-write
 * with an UPDATE; the volume of reactions per move is low enough
 * (low hundreds at most for a viral match) that this is fine.
 *
 * Chat sending is simpler: append-only insert. Caller controls
 * sender-identity validation; this module assumes the caller already
 * authenticated.
 */
import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  matchMoves,
  matchChatMessages,
  type MoveReaction,
  type MatchChatMessage,
} from "@/lib/db/schema";
import { broadcastGame, realtimeEvent } from "@/lib/realtime";

/** Where the reaction lands. */
export type ReactionTarget =
  | { kind: "move"; matchId: string; moveNumber: number }
  | { kind: "chat"; matchId: string; chatMessageId: string };

/** Who's reacting. Exactly one identity field must be set; the rest
 *  are null. */
export interface ReactionSource {
  fromAgentId?: string | null;
  fromBot?: boolean;
  fromOwnerId?: string | null;
  fromAnonymousToken?: string | null;
}

/**
 * Build the canonical source-key used to dedupe tapbacks. Each source
 * has exactly one key derived from whichever identity field is set.
 *
 * Order matters because multiple fields could theoretically be set
 * (defensive — callers shouldn't, but we lock in priority): agent >
 * bot > owner > anon.
 */
function sourceKey(s: ReactionSource): string | null {
  if (s.fromAgentId) return `a:${s.fromAgentId}`;
  if (s.fromBot) return "bot";
  if (s.fromOwnerId) return `o:${s.fromOwnerId}`;
  if (s.fromAnonymousToken) return `t:${s.fromAnonymousToken}`;
  return null;
}

function reactionSourceKey(r: MoveReaction): string | null {
  return sourceKey({
    fromAgentId: r.fromAgentId,
    fromBot: r.fromBot,
    fromOwnerId: r.fromOwnerId,
    fromAnonymousToken: r.fromAnonymousToken,
  });
}

/**
 * Apply tapback semantics to an existing reactions list:
 *   - If the same source previously reacted with the same emoji, the
 *     reaction toggles OFF (returned list omits it).
 *   - If the same source previously reacted with a different emoji,
 *     replace that entry with the new emoji + new timestamp.
 *   - Otherwise, append.
 * Returns the new array (does NOT mutate the input).
 */
export function applyTapback(
  existing: MoveReaction[] | null | undefined,
  next: MoveReaction,
): MoveReaction[] {
  const list = existing ?? [];
  const newKey = reactionSourceKey(next);
  if (!newKey) return list; // unidentifiable source — refuse silently
  const filtered = list.filter((r) => reactionSourceKey(r) !== newKey);
  // Same source + same emoji as the most-recent → toggle off.
  const prev = list.find((r) => reactionSourceKey(r) === newKey);
  if (prev && prev.emoji === next.emoji) {
    return filtered;
  }
  return [...filtered, next];
}

/** Append `next` to a reactions array; never toggles off. Used when
 *  the caller wants an unconditional add (e.g. the bot's automatic
 *  reaction shouldn't toggle if it happens to match a prior bot
 *  reaction). */
export function appendReaction(
  existing: MoveReaction[] | null | undefined,
  next: MoveReaction,
): MoveReaction[] {
  const list = existing ?? [];
  const newKey = reactionSourceKey(next);
  if (!newKey) return list;
  // Replace prior reaction from the same source (still tapback for
  // append semantics — the source can only hold one current reaction).
  const filtered = list.filter((r) => reactionSourceKey(r) !== newKey);
  return [...filtered, next];
}

/**
 * Reactor entry-point. Looks up the target row, applies tapback
 * semantics, persists the updated array, and broadcasts a
 * `ReactionAdded` event to subscribers of the match channel.
 *
 * Returns the post-update reactions list (so the caller can return it
 * to an HTTP client without re-reading).
 */
export async function addReaction(
  target: ReactionTarget,
  source: ReactionSource,
  emoji: string,
  opts: { tapback?: boolean } = {},
): Promise<MoveReaction[]> {
  if (!emoji.trim()) throw new Error("empty_emoji");
  const now = new Date().toISOString();
  const next: MoveReaction = {
    emoji,
    fromAgentId: source.fromAgentId ?? null,
    fromBot: source.fromBot ?? false,
    fromOwnerId: source.fromOwnerId ?? null,
    fromAnonymousToken: source.fromAnonymousToken ?? null,
    at: now,
  };
  const apply = opts.tapback !== false ? applyTapback : appendReaction;

  if (target.kind === "move") {
    const row = await db.query.matchMoves.findFirst({
      where: and(
        eq(matchMoves.matchId, target.matchId),
        eq(matchMoves.moveNumber, target.moveNumber),
      ),
      columns: { id: true, reactions: true },
    });
    if (!row) throw new Error("move_not_found");
    const updated = apply(row.reactions, next);
    await db
      .update(matchMoves)
      .set({ reactions: updated })
      .where(eq(matchMoves.id, row.id));
    await broadcastGame(target.matchId, realtimeEvent.ReactionAdded, {
      targetKind: "move",
      moveNumber: target.moveNumber,
      reactions: updated,
    });
    return updated;
  }

  const row = await db.query.matchChatMessages.findFirst({
    where: eq(matchChatMessages.id, target.chatMessageId),
    columns: { id: true, reactions: true, matchId: true },
  });
  if (!row) throw new Error("chat_message_not_found");
  if (row.matchId !== target.matchId) throw new Error("chat_message_match_mismatch");
  const updated = apply(row.reactions, next);
  await db
    .update(matchChatMessages)
    .set({ reactions: updated })
    .where(eq(matchChatMessages.id, target.chatMessageId));
  await broadcastGame(target.matchId, realtimeEvent.ReactionAdded, {
    targetKind: "chat",
    chatMessageId: target.chatMessageId,
    reactions: updated,
  });
  return updated;
}

/**
 * Send a chat message in a match. Inserts the row, broadcasts a
 * `ChatPosted` event, returns the persisted row. Sender identity:
 * exactly one of fromAgentId / fromBot must be set (this module only
 * handles agent + bot chat; spectator chat goes through the existing
 * chat_messages table).
 */
export async function postMatchChat(args: {
  matchId: string;
  fromAgentId?: string | null;
  fromBot?: boolean;
  body: string;
  replyToMessageId?: string | null;
}): Promise<MatchChatMessage> {
  const body = args.body.trim();
  if (!body) throw new Error("empty_body");
  if (body.length > 280) throw new Error("body_too_long");
  if (!args.fromAgentId && !args.fromBot) {
    throw new Error("missing_sender_identity");
  }
  const [row] = await db
    .insert(matchChatMessages)
    .values({
      matchId: args.matchId,
      fromAgentId: args.fromAgentId ?? null,
      fromBot: args.fromBot ?? false,
      body,
      replyToMessageId: args.replyToMessageId ?? null,
    })
    .returning();
  await broadcastGame(args.matchId, realtimeEvent.ChatPosted, {
    id: row.id,
    matchId: row.matchId,
    fromAgentId: row.fromAgentId,
    fromBot: row.fromBot,
    body: row.body,
    replyToMessageId: row.replyToMessageId,
    createdAt: row.createdAt.toISOString(),
  });
  return row;
}
