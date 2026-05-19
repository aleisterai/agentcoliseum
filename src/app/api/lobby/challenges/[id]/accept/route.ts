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
import { withFixedPayment } from "@/lib/x402/middleware";
import { guardian } from "@/lib/guardian";
import { pullStake, refundStake, StakePullError } from "@/lib/chain/stake";

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

    // Pre-flight: Guardian evaluates force-recall + budget caps against
    // the acceptor's effective per-match cap. The stake is whatever the
    // proposer locked in; the acceptor has to match it.
    const guardianResult = await guardian.evaluate("challenge.accept", {
      agent: myAgent,
      stakeUsdc: challenge.stakeUsdc ?? undefined,
      gameType: challenge.gameType,
    });
    if (!guardianResult.ok) {
      return jsonError(
        403,
        guardianResult.denials[0]?.code ?? "guardian_denied",
        guardianResult.denials.map((d) => d.message).join(" · "),
      );
    }

    // Paid mode: pull the acceptor's stake BEFORE the atomic accept.
    // Sequence:
    //   1. transferFrom(owner, operator, stake) → must succeed
    //   2. acceptChallenge atomically transitions challenge to matched
    //   3. Stamp acceptor_stake_tx_hash on the row
    //
    // Race: if step 2 loses (someone else accepted between steps 1 and 2),
    // we already pulled the acceptor's stake. Refund it.
    let acceptorStakeTxHash: `0x${string}` | null = null;
    const isPaid = challenge.mode === "paid" && challenge.stakeUsdc;
    if (isPaid) {
      try {
        const pull = await pullStake(
          owner.walletAddress as `0x${string}`,
          challenge.stakeUsdc!,
        );
        acceptorStakeTxHash = pull.txHash;
      } catch (err) {
        if (err instanceof StakePullError) {
          const status = err.code === "insufficient_allowance" ? 402 : 400;
          return jsonError(status, err.code, err.message);
        }
        throw err;
      }
    }

    try {
      const match = await acceptChallenge({
        challengeId: challenge.id,
        acceptorAgentId: myAgent.id,
      });
      if (acceptorStakeTxHash) {
        await db
          .update(challenges)
          .set({
            acceptorStakeTxHash,
            acceptorEscrowLockedAt: new Date(),
          })
          .where(eq(challenges.id, challenge.id));
      }
      return NextResponse.json(
        { match, acceptorStakeTxHash },
        { status: 201 },
      );
    } catch (err) {
      // Race-loss refund — we already pulled the acceptor's stake; we
      // didn't end up in the match. Send it back. (`refundStake` is
      // best-effort; if it fails too, operators see both txs and can
      // refund manually from the operator wallet.)
      if (acceptorStakeTxHash) {
        try {
          await refundStake(
            owner.walletAddress as `0x${string}`,
            challenge.stakeUsdc!,
          );
        } catch (refundErr) {
          console.error(
            "[accept] race-loss refund failed; manual intervention needed",
            { challengeId: challenge.id, pull: acceptorStakeTxHash, refundErr },
          );
        }
      }
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

// Paid mode: stake itself is the anti-spam (moved via transferFrom inside
// the handler). Free / system: $0.01 x402 anti-spam.
export const POST = async (req: NextRequest) => {
  const url = new URL(req.url);
  const id = url.pathname.split("/").at(-2)!;
  const challenge = await db.query.challenges.findFirst({ where: eq(challenges.id, id) });
  if (challenge?.mode === "paid") {
    return acceptHandler(req);
  }
  return withFixedPayment(acceptHandler, "$0.01", "Accept challenge")(req);
};
