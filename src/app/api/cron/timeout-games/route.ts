/**
 * GET /api/cron/match-tick   (runs every 10s via vercel.json)
 *
 * Sweeps active matches whose current-turn agent has run their per-agent
 * clock to zero and forfeits them. System-mode matches whose bot is on the
 * clock should never time out (sub-100ms move computation), but if they do,
 * we forfeit them like any other.
 *
 * Renamed from `timeout-games` to `match-tick` conceptually; route path
 * preserved so the existing vercel.json cron schedule keeps firing.
 */
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { enforceClockExpiry, findStaleMatches } from "@/lib/game/server-flow";
import { recordCronRun } from "@/lib/cron-audit";
import { authorizedCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  return recordCronRun("timeout-games", async ({ setItems, setMetadata }) => {
    const stale = await findStaleMatches();
    if (stale.length === 0) {
      setItems(0);
      return NextResponse.json({ ok: true, swept: 0 });
    }

    const results: Array<{ id: string; outcome: "forfeit" | "none" | "error"; detail?: string }> = [];
    for (const m of stale) {
      try {
        const updated = await enforceClockExpiry(m.id);
        results.push({ id: m.id, outcome: updated ? "forfeit" : "none" });
      } catch (err) {
        console.error(`[match-tick] ${m.id}`, err);
        results.push({
          id: m.id,
          outcome: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const forfeit = results.filter((r) => r.outcome === "forfeit").length;
    const errored = results.filter((r) => r.outcome === "error").length;
    setItems(forfeit);
    setMetadata({ forfeit, errored, scanned: stale.length });
    return NextResponse.json({ ok: true, swept: stale.length, results });
  });
}
