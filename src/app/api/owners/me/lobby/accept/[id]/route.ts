/**
 * POST /api/owners/me/lobby/accept/[id]
 *
 * Privy-authed counterpart to /api/lobby/challenges/[id]/accept.
 * Used by the browser-side /lobby/accept/[id] page: the human signs
 * in with Privy, picks which of their agents should take the
 * challenge, and clicks Accept. This route resolves the Privy JWT to
 * the owner, validates the chosen agent belongs to them, then routes
 * through the same `acceptChallenge` server-flow that MCP uses.
 *
 * Auth: `Authorization: Bearer <privy-jwt>`.
 * Body: `{ agentId: string }`.
 *
 * Validation chain (fail-fast, same order as the MCP accept tool):
 *   1. Privy session → wallet → owner row
 *   2. body.agentId belongs to this owner + not recalled
 *   3. challenge exists + status='posted' + not past expires_at
 *   4. if challenge.opponent_handle is set, the chosen agent's handle
 *      must match (pinned challenge)
 *   5. agent's ELO is inside the challenge's [eloMin, eloMax] window
 *   6. owner wallet has the "play" tier
 *   7. Guardian (recall, ELO, budget, allowance)
 *   8. paid mode: pull stake from owner's wallet via USDC.transferFrom
 *   9. acceptChallenge (atomic row-lock; race losers get a refund)
 *
 * Returns `{ matchId, stateUrl }` on success so the page can redirect
 * the user straight to the live match view.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, challenges, owners } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { requireTier, TierInsufficientError } from "@/lib/chain/tiers";
import { guardian } from "@/lib/guardian";
import { pullStake, refundStake, StakePullError } from "@/lib/chain/stake";
import {
  acceptChallenge,
  ChallengeRaceError,
  IllegalMoveError,
  UnknownGameTypeError,
} from "@/lib/game/server-flow";

export const dynamic = "force-dynamic";

const Body = z.object({ agentId: z.string().uuid() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) {
      throw new UnauthorizedError("unauthorized", "Privy session required");
    }
    const checksummed = getAddress(wallet);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, "invalid_request", "Body must be valid JSON.");
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "invalid_request", JSON.stringify(parsed.error.flatten()));
    }
    const { agentId } = parsed.data;

    // 1. Owner row.
    const owner = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (!owner) {
      return jsonError(
        404,
        "owner_not_found",
        "POST /api/owners/me first to seed an owner row.",
      );
    }

    // 2. Agent must belong to this owner + not be recalled.
    const myAgent = await db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.ownerId, owner.id)),
    });
    if (!myAgent) {
      return jsonError(403, "wrong_owner", "Agent doesn't belong to this wallet.");
    }
    if (myAgent.recalledAt) {
      return jsonError(
        409,
        "agent_recalled",
        `Agent is recalled (${myAgent.recallReason ?? "—"}); clear the recall first.`,
      );
    }

    // 3. Challenge must exist + be open + not expired.
    const challenge = await db.query.challenges.findFirst({
      where: eq(challenges.id, id),
    });
    if (!challenge) {
      return jsonError(404, "challenge_not_found", "No such challenge.");
    }
    if (challenge.status !== "posted") {
      return jsonError(
        409,
        "not_open",
        `Challenge is ${challenge.status}; can't accept.`,
      );
    }
    if (challenge.expiresAt && challenge.expiresAt.getTime() < Date.now()) {
      return jsonError(
        409,
        "expired",
        "Challenge has expired. The refund cron will sweep it shortly.",
      );
    }

    // 4. Pinned challenge — opponent_handle must match the chosen agent.
    if (challenge.opponentHandle && challenge.opponentHandle !== myAgent.handle) {
      return jsonError(
        403,
        "pinned_to_other",
        `This challenge is pinned to @${challenge.opponentHandle}; @${myAgent.handle} can't accept it.`,
      );
    }

    // 5. ELO band.
    if (challenge.eloMin != null && myAgent.elo < challenge.eloMin) {
      return jsonError(
        409,
        "elo_below_min",
        `Your ELO ${myAgent.elo} < min ${challenge.eloMin}.`,
      );
    }
    if (challenge.eloMax != null && myAgent.elo > challenge.eloMax) {
      return jsonError(
        409,
        "elo_above_max",
        `Your ELO ${myAgent.elo} > max ${challenge.eloMax}.`,
      );
    }

    // 6. Tier gate.
    try {
      await requireTier(checksummed as `0x${string}`, "play");
    } catch (e) {
      const msg = e instanceof TierInsufficientError ? e.message : String(e);
      return jsonError(403, "tier_insufficient", msg);
    }

    // 7. Guardian.
    const g = await guardian.evaluate("challenge.accept", {
      agent: myAgent,
      stakeUsdc: challenge.stakeUsdc ?? undefined,
      gameType: challenge.gameType,
    });
    if (!g.ok) {
      return jsonError(
        403,
        g.denials[0]?.code ?? "guardian_denied",
        g.denials.map((d) => d.message).join(" · "),
      );
    }

    // 8. Pull stake (paid only).
    let acceptorStakeTxHash: `0x${string}` | null = null;
    const isPaid = challenge.mode === "paid" && challenge.stakeUsdc;
    if (isPaid) {
      try {
        const pull = await pullStake(checksummed, challenge.stakeUsdc!);
        acceptorStakeTxHash = pull.txHash;
      } catch (err) {
        if (err instanceof StakePullError) {
          return jsonError(402, err.code, err.message);
        }
        throw err;
      }
    }

    // 9. Atomic accept.
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
      return NextResponse.json({
        matchId: match.id,
        stateUrl: `/match/${match.id}`,
      });
    } catch (err) {
      // Race-loss refund: best-effort. Log but surface the original error.
      if (acceptorStakeTxHash) {
        try {
          await refundStake(checksummed, challenge.stakeUsdc!);
        } catch (refundErr) {
          console.error("[lobby/accept] race-loss refund failed", {
            challengeId: challenge.id,
            pull: acceptorStakeTxHash,
            refundErr,
          });
        }
      }
      if (err instanceof ChallengeRaceError) {
        return jsonError(
          409,
          "challenge_already_accepted",
          "Someone else accepted the challenge first.",
        );
      }
      if (err instanceof IllegalMoveError) {
        return jsonError(400, "accept_failed", err.message);
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
