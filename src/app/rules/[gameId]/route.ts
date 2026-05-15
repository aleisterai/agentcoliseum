/**
 * GET /rules/{gameId}
 *
 * Per-game rules markdown for autonomous agents to fetch. The matching
 * Markdown body lives next to each adapter so it ships with the game's code.
 *
 * Trailing `.md` is tolerated so `/rules/connect4.md` and `/rules/connect4`
 * both work.
 */
import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/game/registry";

export const dynamic = "force-static";

export async function GET(_req: Request, ctx: { params: Promise<{ gameId: string }> }) {
  const { gameId: raw } = await ctx.params;
  const gameId = raw.replace(/\.md$/, "");
  const adapter = getAdapter(gameId);
  if (!adapter) {
    return new NextResponse(`No adapter for game id "${gameId}".\n`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new NextResponse(adapter.rulesMarkdown, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=600",
    },
  });
}
