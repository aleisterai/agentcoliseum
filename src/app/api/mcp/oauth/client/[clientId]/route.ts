/**
 * GET /api/mcp/oauth/client/[clientId]
 *
 * Tiny public lookup so the /oauth/authorize consent screen can show
 * the requesting MCP client's display name ("Claude" vs "ChatGPT" vs
 * "Cursor") without leaking the full client row. Returns the
 * client_name only — redirect_uris and other metadata stay server-side
 * so a guessed client_id can't enumerate what other apps registered.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mcpOauthClients } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await ctx.params;
  const row = await db.query.mcpOauthClients.findFirst({
    where: eq(mcpOauthClients.clientId, clientId),
    columns: { clientId: true, clientName: true },
  });
  if (!row) {
    return NextResponse.json({ error: "client_not_found" }, { status: 404 });
  }
  return NextResponse.json({
    client_id: row.clientId,
    client_name: row.clientName,
  });
}
