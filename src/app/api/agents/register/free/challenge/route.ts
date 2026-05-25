/**
 * GET /api/agents/register/free/challenge
 *
 * Issues a PoW challenge for the free-tier registration flow. The
 * `npx @agentcoliseum/init` CLI hits this first, solves the puzzle
 * locally, then POSTs to /api/agents/register/free with the solution.
 *
 * Difficulty ratchets per-IP — first request from an IP-hash gets the
 * default ~20-bit puzzle (~1 second), subsequent requests in the same
 * window get harder. Honest users see one-second cost; scripted
 * attackers see exponentially rising cost.
 *
 * Public endpoint, no auth required.
 */

import "server-only";
import { NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { freeRegistrationLog } from "@/lib/db/schema";
import {
  DEFAULT_DIFFICULTY,
  MAX_DIFFICULTY,
  hashIp,
  issueChallenge,
} from "@/lib/pow";

export const dynamic = "force-dynamic";

/** How far back to look when computing per-IP difficulty escalation.
 *  1 hour matches the rate-limit window in the POST endpoint. */
const ESCALATION_WINDOW_MS = 60 * 60 * 1_000;

/** Per-IP additional bits of difficulty per prior registration in the
 *  window. So 0 prior → 20 bits; 1 prior → 22; 3 prior → 26;
 *  rate-limit kicks in at 3+. */
const DIFFICULTY_STEP = 2;

export async function GET(req: Request) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const ipHashed = hashIp(ip);

  // Count prior successful registrations from this IP in the window.
  const since = new Date(Date.now() - ESCALATION_WINDOW_MS);
  const recent = await db
    .select()
    .from(freeRegistrationLog)
    .where(
      and(
        eq(freeRegistrationLog.ipHash, ipHashed),
        gt(freeRegistrationLog.createdAt, since),
      ),
    );
  const escalated = Math.min(
    MAX_DIFFICULTY,
    DEFAULT_DIFFICULTY + recent.length * DIFFICULTY_STEP,
  );

  const challenge = issueChallenge({ difficulty: escalated });
  return NextResponse.json(challenge);
}
