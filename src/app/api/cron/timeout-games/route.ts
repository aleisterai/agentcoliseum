/**
 * GET /api/cron/timeout-games   (runs every minute via vercel.json)
 *
 * Sweeps active games whose currentTurnAgentId has not moved within the
 * per-game timeout (default 30s). Forfeits to the opponent. Same Elo +
 * treasury cascading as a normal win finalization.
 *
 * For system-bot games where the bot is on the clock (currentTurnAgentId is
 * null), we DRIVE the bot instead of forfeiting — the bot should never time
 * out in real life (its move computation is sub-100ms even at hard
 * difficulty), but if the inline cascade missed, this is the safety net.
 */
import { NextResponse } from "next/server";
import { and, eq, isNotNull, lt, sql as dsql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { games } from "@/lib/db/schema";
import { driveSystemBot, finalizeGame } from "@/lib/game/server-flow";
import { jsonError } from "@/lib/http";
import type { State } from "boardgame.io";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function authorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  if (req.headers.get("x-vercel-cron-signature")) return true;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return jsonError(401, "unauthorized", "Cron secret required");

  // Find games where lastMoveAt is older than moveTimeoutSec and status is active.
  const stale = await db
    .select()
    .from(games)
    .where(
      and(
        eq(games.status, "active"),
        isNotNull(games.lastMoveAt),
        lt(games.lastMoveAt, dsql`now() - (${games.moveTimeoutSec} || ' seconds')::interval`),
      ),
    )
    .limit(50);

  if (stale.length === 0) {
    return NextResponse.json({ ok: true, swept: 0 });
  }

  const results: Array<{ id: string; action: "forfeit" | "bot_moved" | "error"; detail?: string }> = [];

  for (const g of stale) {
    try {
      if (g.mode === "system" && g.currentTurnAgentId === null) {
        // It's the bot's turn — drive it instead of forfeiting.
        await driveSystemBot(g);
        results.push({ id: g.id, action: "bot_moved" });
      } else {
        // Forfeit the agent whose turn it is. The OPPONENT wins.
        const opponentId =
          g.currentTurnAgentId === g.initiatorAgentId
            ? g.acceptorAgentId
            : g.initiatorAgentId;
        await finalizeGame(g, g.state as State<unknown>, opponentId);
        results.push({ id: g.id, action: "forfeit" });
      }
    } catch (err) {
      console.error(`[cron/timeout-games] ${g.id}`, err);
      results.push({
        id: g.id,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ ok: true, swept: stale.length, results });
}
