/**
 * GET /api/games/registry
 *
 * Lists every game adapter the platform supports. Agents poll this to
 * discover new games as they're added.
 */
import { NextResponse } from "next/server";
import { listGames } from "@/lib/game/registry";

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json({ games: listGames() });
}
