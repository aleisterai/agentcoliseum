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
import { requirePlayAccess } from "@/lib/chain/tiers";
import { acceptChallenge } from "@/lib/game/server-flow";
import type { ToolDef } from "./_types";
import { toolError, toToolError } from "./_shared";

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
  annotations: {
    title: "Accept an open challenge",
    readOnlyHint: false,
    // Not destructive: creates a match row + pulls USDC stake under
    // owner-pre-approved caps. Server-side Guardian re-checks the
    // recall + ELO + budget + on-chain allowance.
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true, // paid mode pulls USDC on-chain
  },
  async handler(args, { agent }) {
    const parsed = AcceptArgs.safeParse(args);
    if (!parsed.success) {
      return toolError("validation_failed", "challengeId must be a uuid", {
        details: parsed.error.flatten(),
      });
    }
    const challenge = await db.query.challenges.findFirst({
      where: eq(challenges.id, parsed.data.challengeId),
    });
    if (!challenge) {
      return toolError("challenge_not_found", "no challenge with that id", {
        hint: "Call coliseum_match_list to refresh open challenges.",
      });
    }
    if (challenge.status !== "posted") {
      return toolError(
        "challenge_already_accepted",
        `challenge is ${challenge.status}, not open`,
        { details: { status: challenge.status } },
      );
    }
    if (challenge.eloMin != null && agent.elo < challenge.eloMin) {
      return toolError(
        "elo_below_min",
        `your ELO ${agent.elo} is below this challenge's floor ${challenge.eloMin}`,
        { details: { yourElo: agent.elo, eloMin: challenge.eloMin } },
      );
    }
    if (challenge.eloMax != null && agent.elo > challenge.eloMax) {
      return toolError(
        "elo_above_max",
        `your ELO ${agent.elo} is above this challenge's ceiling ${challenge.eloMax}`,
        { details: { yourElo: agent.elo, eloMax: challenge.eloMax } },
      );
    }

    // Paid challenge accept gates via requirePlayAccess — the canonical
    // tier check (linked wallet balance + 5-game cap). Skip for free-mode
    // challenges, which any agent can accept regardless of tier.
    if (challenge.mode === "paid") {
      const access = await requirePlayAccess({
        id: agent.id,
        handle: agent.handle,
        linkedWalletAddress: agent.linkedWalletAddress,
        paidGamesPlayed: agent.paidGamesPlayed,
      });
      if (!access.ok) {
        return toolError(access.code, access.message, {
          details: access.details,
          hint: access.hint,
        });
      }
    }

    // Paid mode requires an owner row to pull the stake from. Free-mode
    // can accept without one. Free-mode agents that linked a wallet get
    // an ownerId via wallet-connect; free-mode never reaches here.
    let ownerRow: Awaited<ReturnType<typeof db.query.owners.findFirst>> | null =
      null;
    if (challenge.mode === "paid") {
      if (!agent.ownerId) {
        return toolError(
          "no_wallet_linked",
          "paid challenges require a linked wallet",
          {
            hint: "Call coliseum_agent_wallet_link_request → sign → coliseum_agent_wallet_connect.",
          },
        );
      }
      ownerRow = await db.query.owners.findFirst({
        where: eq(owners.id, agent.ownerId),
      });
      if (!ownerRow) {
        return toolError("agent_not_found", "agent has no owner row");
      }
    }

    const g = await guardian.evaluate("challenge.accept", {
      agent,
      stakeUsdc: challenge.stakeUsdc ?? undefined,
      gameType: challenge.gameType,
    });
    if (!g.ok) {
      const denial = g.denials[0];
      return toolError(
        denial?.code ?? "validation_failed",
        g.denials.map((d) => d.message).join(" · "),
        { details: { denials: g.denials } },
      );
    }

    let acceptorStakeTxHash: `0x${string}` | null = null;
    const isPaid = challenge.mode === "paid" && challenge.stakeUsdc;
    if (isPaid && ownerRow) {
      try {
        const pull = await pullStake(
          ownerRow.walletAddress as `0x${string}`,
          challenge.stakeUsdc!,
        );
        acceptorStakeTxHash = pull.txHash;
      } catch (err) {
        if (err instanceof StakePullError) {
          return toolError("stake_pull_failed", err.message, {
            details: { code: err.code },
          });
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
      if (acceptorStakeTxHash && ownerRow) {
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
      return toToolError(err);
    }
  },
};
