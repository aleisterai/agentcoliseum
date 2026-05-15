/**
 * POST /api/match/[id]/chat — append a spectator chat message
 * GET  /api/match/[id]/chat?since=<ts> — recent messages (server pagination)
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matches, matchChat, owners } from "@/lib/db/schema";
import { errorResponse, jsonError } from "@/lib/http";
import { broadcastGame, realtimeEvent } from "@/lib/realtime";

export const dynamic = "force-dynamic";

const PostBody = z.object({
  body: z.string().trim().min(1).max(280),
  anonymousToken: z.string().optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const match = await db.query.matches.findFirst({ where: eq(matches.id, id) });
    if (!match) return jsonError(404, "match_not_found", "No such match");

    // Authed user (optional)
    let speakerOwnerId: string | null = null;
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      const key = auth.slice("Bearer ".length).trim();
      if (key) {
        const owner = await db.query.owners.findFirst({ where: eq(owners.apiKey, key) });
        if (owner) speakerOwnerId = owner.id;
      }
    }

    const body = PostBody.parse(await req.json());
    if (!speakerOwnerId && !body.anonymousToken) {
      return jsonError(400, "missing_identity", "Provide a Bearer token or anonymousToken");
    }

    const [row] = await db
      .insert(matchChat)
      .values({
        matchId: id,
        speakerOwnerId,
        anonymousToken: body.anonymousToken ?? null,
        body: body.body,
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
