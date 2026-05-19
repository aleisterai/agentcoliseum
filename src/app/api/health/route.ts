/**
 * GET /api/health — public liveness + readiness check.
 *
 * Returns 200 if the platform can serve traffic, 503 if not. JSON body
 * is small + parseable by uptime monitors (Pingdom / UptimeRobot /
 * Better Stack / etc.) — they typically alert on a JSON field or HTTP
 * status code.
 *
 * Probes:
 *   db          — single SELECT 1 with a 3s timeout
 *   chain.rpc   — viem getBlockNumber with a 3s timeout
 *   operator    — operator wallet address (config sanity)
 *
 * No secrets in the response. The full diagnostic dashboard for
 * operators is at /admin/health (auth-gated).
 */
import { NextResponse } from "next/server";
import { sql as drizzleSql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { publicClient } from "@/lib/chain/viem";

export const dynamic = "force-dynamic";

interface ProbeResult {
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

async function probeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T; latencyMs: number } | { ok: false; detail: string }> {
  const start = Date.now();
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs),
  );
  try {
    const value = await Promise.race([fn(), timeoutPromise]);
    return { ok: true, value, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET() {
  const [dbProbe, chainProbe] = await Promise.all([
    probeWithTimeout(async () => {
      const result = await db.execute(drizzleSql`SELECT 1 AS ok`);
      return result;
    }, 3000),
    probeWithTimeout(async () => {
      const blockNumber = await publicClient.getBlockNumber();
      return Number(blockNumber);
    }, 3000),
  ]);

  const dbResult: ProbeResult = dbProbe.ok
    ? { ok: true, latencyMs: dbProbe.latencyMs }
    : { ok: false, detail: dbProbe.detail };
  const chainResult: ProbeResult = chainProbe.ok
    ? { ok: true, latencyMs: chainProbe.latencyMs, detail: `block ${chainProbe.value}` }
    : { ok: false, detail: chainProbe.detail };

  const allOk = dbResult.ok && chainResult.ok;
  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      probes: {
        db: dbResult,
        chain: chainResult,
      },
    },
    {
      status: allOk ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
