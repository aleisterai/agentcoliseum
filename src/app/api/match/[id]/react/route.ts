/**
 * POST /api/match/[id]/react — spectator tapback on a specific move
 * or chat message.
 *
 * Different from /api/match/[id]/chat's reaction branch:
 *   /chat (reaction)  → match-level aggregated emoji counter
 *   /react            → per-target tapback (this endpoint)
 *
 * Spectators don't authenticate via MCP. Identity resolution:
 *   - logged-in owner → bearer in `Authorization: Bearer <ownerApiKey>`
 *     resolves to `fromOwnerId`. The owner's tapback dedupes against
 *     other tapbacks they made on the same target.
 *   - anonymous     → client passes a stable `anonymousToken` (derived
 *     once per browser + persisted to localStorage). If absent, we
 *     derive one from IP + user-agent so users still get tapback
 *     dedupe semantics across a session, but it's NOT cross-session.
 *
 * Both resolutions land in `addReaction`, which applies tapback rules
 * (latest wins; same emoji toggles off) and broadcasts ReactionAdded.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matches, matchChatMessages, owners } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";
import { addReaction } from "@/lib/game/server-flow";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    target: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("move"),
          moveNumber: z.number().int().min(0),
        })
        .strict(),
      z
        .object({
          kind: z.literal("chat"),
          chatMessageId: z.string().uuid(),
        })
        .strict(),
    ]),
    emoji: z.string().trim().min(1).max(8),
    /** Optional client-provided anon token (stable per browser). */
    anonymousToken: z.string().min(1).max(64).optional(),
  })
  .strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const match = await db.query.matches.findFirst({
      where: eq(matches.id, id),
      columns: { id: true },
    });
    if (!match) return jsonError(404, "match_not_found", "No such match");

    const parsed = Body.parse(await req.json());

    // Resolve identity. Owner bearer takes precedence over anon token.
    let fromOwnerId: string | null = null;
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      const key = auth.slice("Bearer ".length).trim();
      if (key) {
        const owner = await db.query.owners.findFirst({
          where: eq(owners.apiKey, key),
          columns: { id: true },
        });
        if (owner) fromOwnerId = owner.id;
      }
    }
    const fromAnonymousToken =
      fromOwnerId
        ? null
        : parsed.anonymousToken ??
          deriveAnonToken(
            req.headers.get("x-forwarded-for"),
            req.headers.get("user-agent"),
          );

    // If target is a chat message, double-check it belongs to this match
    // before handing off — gives a cleaner 4xx than letting addReaction
    // surface an internal error.
    if (parsed.target.kind === "chat") {
      const chat = await db.query.matchChatMessages.findFirst({
        where: eq(matchChatMessages.id, parsed.target.chatMessageId),
        columns: { matchId: true },
      });
      if (!chat) {
        return jsonError(404, "chat_message_not_found", "No such chat message");
      }
      if (chat.matchId !== id) {
        return jsonError(400, "chat_message_match_mismatch", "Chat is in another match");
      }
    }

    const reactions = await addReaction(
      parsed.target.kind === "move"
        ? { kind: "move", matchId: id, moveNumber: parsed.target.moveNumber }
        : { kind: "chat", matchId: id, chatMessageId: parsed.target.chatMessageId },
      { fromOwnerId, fromAnonymousToken },
      parsed.emoji,
    );

    return NextResponse.json({ reactions }, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Stable-enough anon token for a single browser session when the
 * client didn't pass one. Hash of IP + UA. Not cryptographically
 * secret — its only purpose is to dedupe tapbacks from the same
 * spectator on the same target.
 */
function deriveAnonToken(ip: string | null, ua: string | null): string {
  const seed = `${ip ?? "?"}::${ua ?? "?"}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
