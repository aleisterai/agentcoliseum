/**
 * POST /api/lobby/challenges/[id]/accept
 *
 * Atomic accept: locks the challenge row, creates a match, transitions the
 * challenge to `escrowed`. x402-gated: $0.01 anti-spam for free, matched
 * stake for paid.
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, challenges } from "@/lib/db/schema";
import { requireOwnerByApiKey } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { requireTier } from "@/lib/chain/tiers";
import {
  acceptChallenge,
  ChallengeRaceError,
  IllegalMoveError,
  UnknownGameTypeError,
} from "@/lib/game/server-flow";
import { withDynamicPayment } from "@/lib/x402/middleware";
import { dollarsFromUsdc6 } from "@/lib/x402/pricing";

export const dynamic = "force-dynamic";

async function acceptHandler(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.pathname.split("/").at(-2)!;

    const owner = await requireOwnerByApiKey(req);
    await requireTier(owner.walletAddress as `0x${string}`, "play");

    const myAgent = await db.query.agents.findFirst({ where: eq(agents.ownerId, owner.id) });
    if (!myAgent) return jsonError(409, "no_agent", "Register an agent first");

    // Elo filter check (best-effort; race-safe enforcement is on the DB transaction)
    const challenge = await db.query.challenges.findFirst({ where: eq(challenges.id, id) });
    if (!challenge) return jsonError(404, "challenge_not_found", "No such challenge");
    if (challenge.status !== "posted") {
      return jsonError(409, "not_open", `Challenge is ${challenge.status}`);
    }
    if (challenge.eloMin != null && myAgent.elo < challenge.eloMin) {
      return jsonError(409, "elo_below_min", `Your Elo ${myAgent.elo} < min ${challenge.eloMin}`);
    }
    if (challenge.eloMax != null && myAgent.elo > challenge.eloMax) {
      return jsonError(409, "elo_above_max", `Your Elo ${myAgent.elo} > max ${challenge.eloMax}`);
    }

    try {
      const match = await acceptChallenge({
        challengeId: challenge.id,
        acceptorAgentId: myAgent.id,
      });
      return NextResponse.json({ match }, { status: 201 });
    } catch (err) {
      if (err instanceof ChallengeRaceError) {
        return jsonError(409, "challenge_already_accepted", err.message);
      }
      if (err instanceof IllegalMoveError) {
        return jsonError(409, "accept_failed", err.message);
      }
      if (err instanceof UnknownGameTypeError) {
        return jsonError(500, "unknown_game_type", err.message);
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}

export const POST = withDynamicPayment(
  acceptHandler,
  async (req) => {
    const url = new URL(req.url);
    const id = url.pathname.split("/").at(-2)!;
    const challenge = await db.query.challenges.findFirst({ where: eq(challenges.id, id) });
    if (challenge?.mode === "paid" && challenge.stakeUsdc) {
      return dollarsFromUsdc6(challenge.stakeUsdc);
    }
    return "$0.01";
  },
  "Accept challenge",
);
