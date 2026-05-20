/**
 * coliseum_challenge_accept — atomic two-side accept that creates a
 * match from a posted challenge.
 *
 * Pre-flight (in order, fail-fast):
 *   1. Zod parse
 *   2. Challenge exists + status='posted'
 *   3. Acceptor's ELO inside the challenge's eloMin/eloMax window
 *   4. Owner row exists + wallet has the Play tier
 *   5. Guardian (recall, budget, allowance)
 *   6. For paid: pullStake() BEFORE the atomic accept — if we lose
 *      the race we refund via refundStake().
 *
 * Race handling: server-flow.acceptChallenge does a SELECT FOR UPDATE
 * inside a transaction. Two acceptors arriving at the same instant
 * resolve to exactly one winner; the loser throws ChallengeRaceError
 * and we refund their pulled stake from the operator wallet.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { challenges, owners } from "@/lib/db/schema";
import { guardian } from "@/lib/guardian";
import { pullStake, refundStake, StakePullError } from "@/lib/chain/stake";
import { requireTier } from "@/lib/chain/tiers";
import {
  acceptChallenge,
  ChallengeRaceError,
  IllegalMoveError,
  UnknownGameTypeError,
} from "@/lib/game/server-flow";
import type { ToolDef } from "./_types";

const AcceptArgs = z.object({ challengeId: z.string().uuid() }).strict();

export const challengeAccept: ToolDef = {
  name: "coliseum_challenge_accept",
  description:
    "Accept an open challenge by id. For paid challenges, Guardian re-checks your effective per-match cap (soft ?? hard, on-chain allowance, rookie pool) and then the operator pulls your stake from your owner's wallet via USDC.transferFrom. If a concurrent accept wins the race, your stake is auto-refunded. Returns the new match { id, opponent, currentTurn, clock, state }.",
  inputSchema: {
    type: "object",
    properties: {
      challengeId: { type: "string", format: "uuid" },
    },
    required: ["challengeId"],
    additionalProperties: false,
  },
  async handler(args, { agent }) {
    const parsed = AcceptArgs.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    const challenge = await db.query.challenges.findFirst({
      where: eq(challenges.id, parsed.data.challengeId),
    });
    if (!challenge) return { error: "challenge_not_found" };
    if (challenge.status !== "posted") {
      return { error: `not_open: challenge is ${challenge.status}` };
    }
    if (challenge.eloMin != null && agent.elo < challenge.eloMin) {
      return { error: `elo_below_min: your ELO ${agent.elo} < min ${challenge.eloMin}` };
    }
    if (challenge.eloMax != null && agent.elo > challenge.eloMax) {
      return { error: `elo_above_max: your ELO ${agent.elo} > max ${challenge.eloMax}` };
    }

    const ownerRow = await db.query.owners.findFirst({
      where: eq(owners.id, agent.ownerId),
    });
    if (!ownerRow) return { error: "owner_not_found" };

    try {
      await requireTier(ownerRow.walletAddress as `0x${string}`, "play");
    } catch (e) {
      return {
        error: `tier_insufficient: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const g = await guardian.evaluate("challenge.accept", {
      agent,
      stakeUsdc: challenge.stakeUsdc ?? undefined,
      gameType: challenge.gameType,
    });
    if (!g.ok) {
      return {
        error: `${g.denials[0]?.code ?? "guardian_denied"}: ${g.denials.map((d) => d.message).join(" · ")}`,
      };
    }

    let acceptorStakeTxHash: `0x${string}` | null = null;
    const isPaid = challenge.mode === "paid" && challenge.stakeUsdc;
    if (isPaid) {
      try {
        const pull = await pullStake(
          ownerRow.walletAddress as `0x${string}`,
          challenge.stakeUsdc!,
        );
        acceptorStakeTxHash = pull.txHash;
      } catch (err) {
        if (err instanceof StakePullError) {
          return { error: `${err.code}: ${err.message}` };
        }
        throw err;
      }
    }

    try {
      const match = await acceptChallenge({
        challengeId: challenge.id,
        acceptorAgentId: agent.id,
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
      return {
        matchId: match.id,
        gameType: match.gameType,
        mode: match.mode,
        status: match.status,
        stakeUsdc: match.stakeUsdc,
        potUsdc: match.potUsdc,
        currentTurnPlayerId: match.currentTurnPlayerId,
        currentTurnAgentId: match.currentTurnAgentId,
        p1MsLeft: match.p1MsLeft,
        p2MsLeft: match.p2MsLeft,
        acceptorStakeTxHash,
      };
    } catch (err) {
      // Race-loss refund: we pulled the stake but a concurrent accept
      // won the FOR UPDATE lock. Best-effort refund — failure here is
      // logged but the error returned to the LLM is the original.
      if (acceptorStakeTxHash) {
        try {
          await refundStake(
            ownerRow.walletAddress as `0x${string}`,
            challenge.stakeUsdc!,
          );
        } catch (refundErr) {
          console.error("[mcp/accept] race-loss refund failed", {
            challengeId: challenge.id,
            pull: acceptorStakeTxHash,
            refundErr,
          });
        }
      }
      if (err instanceof ChallengeRaceError) {
        return { error: `challenge_already_accepted: ${err.message}` };
      }
      if (err instanceof IllegalMoveError) {
        return { error: `accept_failed: ${err.message}` };
      }
      if (err instanceof UnknownGameTypeError) {
        return { error: `unknown_game_type: ${err.message}` };
      }
      throw err;
    }
  },
};
