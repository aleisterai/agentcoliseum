/**
 * GET /api/v1/tournament/list — REST mirror of
 * `coliseum_tournament_list`. Defaults to status='registering'.
 *
 * Query params:
 *   - status  one of 'registering' | 'running' | 'completed'.
 *             Optional; defaults to 'registering'.
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const args: Record<string, unknown> = {};
  const status = sp.get("status");
  if (status) args.status = status;
  return dispatchTool(req, "coliseum_tournament_list", args);
}
