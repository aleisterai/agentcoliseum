/**
 * recordCronRun — wraps a cron handler with structured observability.
 *
 * Inserts one `cron_runs` row per tick with start + end timestamps,
 * outcome (ok / error), items_processed counter, duration, and any
 * metadata the handler chooses to attach. /admin/health reads from
 * this table to show "what each cron actually did, when" instead of
 * inferring from indirect side-effects.
 *
 * Usage in a cron route:
 *
 *   export async function GET(req: Request) {
 *     if (!authorized(req)) return jsonError(401, ...);
 *     return recordCronRun("settlement-sweep", async ({ setItems }) => {
 *       const results = await doTheActualWork();
 *       setItems(results.filter((r) => r.outcome === "paid").length);
 *       return NextResponse.json({ ok: true, ...results });
 *     });
 *   }
 *
 * Failures: if the handler throws, we record `ok=false` + the error
 * message, then re-throw so Next.js + Vercel see the 500. The
 * handler doesn't need its own try/catch around the work — the
 * wrapper owns that.
 */
import "server-only";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { cronRuns } from "@/lib/db/schema";

export interface CronContext {
  /** Mark how many items the cron actually processed (e.g. payouts swept). */
  setItems: (n: number) => void;
  /** Attach freeform metadata that shows up on /admin/health. */
  setMetadata: (m: Record<string, unknown>) => void;
}

export async function recordCronRun(
  name: string,
  handler: (ctx: CronContext) => Promise<Response>,
): Promise<Response> {
  let itemsProcessed = 0;
  let metadata: Record<string, unknown> | undefined;
  const ctx: CronContext = {
    setItems: (n) => {
      itemsProcessed = n;
    },
    setMetadata: (m) => {
      metadata = m;
    },
  };

  const startedAt = new Date();
  // Insert the "started" row first so a hang / timeout still shows up
  // in the audit log. We update it on completion (or never, if the
  // process dies — that's the smoking-gun signal we want).
  let runId: string | null = null;
  try {
    const [row] = await db
      .insert(cronRuns)
      .values({ name, startedAt })
      .returning({ id: cronRuns.id });
    runId = row.id;
  } catch (err) {
    // If we can't write the start marker, the cron will still run.
    // Better to do the work + lose the audit row than skip the work.
    console.warn(`[cron-audit] failed to record start for ${name}`, err);
  }

  try {
    const response = await handler(ctx);
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    if (runId) {
      await db
        .update(cronRuns)
        .set({
          completedAt,
          ok: true,
          itemsProcessed,
          durationMs,
          metadata: metadata ?? null,
        })
        .where(eqId(runId))
        .catch((err) =>
          console.warn(`[cron-audit] failed to record completion for ${name}`, err),
        );
    }
    return response;
  } catch (err) {
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (runId) {
      await db
        .update(cronRuns)
        .set({
          completedAt,
          ok: false,
          error: errorMessage.slice(0, 2000),
          itemsProcessed,
          durationMs,
          metadata: metadata ?? null,
        })
        .where(eqId(runId))
        .catch((auditErr) =>
          console.warn(`[cron-audit] failed to record failure for ${name}`, auditErr),
        );
    }
    // Re-throw so Next.js returns 500 and Vercel marks the cron as failed.
    throw err;
  }
}

// Tiny local helper to avoid importing eq from drizzle-orm twice.
import { eq } from "drizzle-orm";
function eqId(id: string) {
  return eq(cronRuns.id, id);
}
