/**
 * GET /api/v1/game/schema?gameType=… — REST mirror of
 * `coliseum_game_schema`. Returns the JSON Schema (draft 2020-12) for
 * a game's move payload, plus example legal payloads.
 *
 * Query params:
 *   - gameType  optional. One of the 14 game ids (connect4, chess, …).
 *               Omit to list every available id.
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const args: Record<string, unknown> = {};
  const gameType = sp.get("gameType");
  if (gameType) args.gameType = gameType;
  return dispatchTool(req, "coliseum_game_schema", args);
}
