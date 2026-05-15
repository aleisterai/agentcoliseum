/**
 * POST /api/match/[id]/chat — append a spectator chat message OR record a reaction
 *   body shape: { body: string }              → chat message
 *   body shape: { reaction: string }          → emoji reaction (aggregated)
 * GET  /api/match/[id]/chat?since=<ts> — recent messages
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matches, matchChat, matchReactions, owners } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";
import { broadcastGame, realtimeEvent } from "@/lib/realtime";

export const dynamic = "force-dynamic";

const PostBody = z.union([
  z.object({ body: z.string().trim().min(1).max(280), anonymousToken: z.string().optional() }),
  z.object({ reaction: z.string().trim().min(1).max(8) }),
]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const match = await db.query.matches.findFirst({ where: eq(matches.id, id) });
    if (!match) return jsonError(404, "match_not_found", "No such match");

    let speakerOwnerId: string | null = null;
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      const key = auth.slice("Bearer ".length).trim();
      if (key) {
        const owner = await db.query.owners.findFirst({ where: eq(owners.apiKey, key) });
        if (owner) speakerOwnerId = owner.id;
      }
    }

    const parsed = PostBody.parse(await req.json());

    // Reaction branch — aggregated counter per match × emoji.
    if ("reaction" in parsed) {
      const [row] = await db
        .insert(matchReactions)
        .values({ matchId: id, emoji: parsed.reaction, count: 1 })
        .returning();
      await broadcastGame(id, realtimeEvent.Reaction, { emoji: parsed.reaction });
      return NextResponse.json(row, { status: 201 });
    }

    // Chat branch — anonymous spectators get a stable per-session token via IP+UA hash.
    const anonToken =
      parsed.anonymousToken ??
      deriveAnonToken(req.headers.get("x-forwarded-for"), req.headers.get("user-agent"));

    const [row] = await db
      .insert(matchChat)
      .values({
        matchId: id,
        speakerOwnerId,
        anonymousToken: speakerOwnerId ? null : anonToken,
        body: parsed.body,
      })
      .returning();

    await broadcastGame(id, realtimeEvent.ChatMessage, {
      id: row.id,
      body: row.body,
      speakerOwnerId: row.speakerOwnerId,
      anonymousToken: row.anonymousToken,
      createdAt: row.createdAt.toISOString(),
    });
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { searchParams } = new URL(req.url);
    const since = searchParams.get("since");
    const sinceDate = since ? new Date(since) : null;
    const where = sinceDate
      ? and(eq(matchChat.matchId, id), gt(matchChat.createdAt, sinceDate))
      : eq(matchChat.matchId, id);
    const rows = await db
      .select()
      .from(matchChat)
      .where(where)
      .orderBy(desc(matchChat.createdAt))
      .limit(100);
    return NextResponse.json({ matchId: id, messages: rows });
  } catch (err) {
    return errorResponse(err);
  }
}

// Stable-but-coarse anon identity. Not for moderation — just so chat shows a
// recognizable @viewer-xxxx handle across messages from the same session.
function deriveAnonToken(ip: string | null, ua: string | null): string {
  const src = `${ip ?? "ip?"}|${ua ?? "ua?"}`;
  let h = 5381;
  for (const ch of src) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return `viewer-${h.toString(36).slice(0, 6)}`;
}
