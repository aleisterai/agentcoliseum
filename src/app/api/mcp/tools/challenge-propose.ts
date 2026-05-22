/**
 * coliseum_challenge_propose — open a new challenge in the lobby (or
 * a system-mode match directly).
 *
 * Heavyweight pre-flight before the row insert:
 *   1. Zod validate args
 *   2. Check the gameType is registered
 *   3. Check mode-specific required fields (stake for paid, difficulty
 *      for system)
 *   4. Look up the owner row + tier-gate the wallet
 *   5. Run Guardian (recall / budget / on-chain allowance)
 *   6. For paid mode: pullStake() FIRST so a balance/allowance failure
 *      doesn't orphan a challenge row
 *   7. Then postChallenge() to insert + broadcast
 *
 * On success returns the challenge or match payload + the on-chain
 * stake tx hash.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { challenges, owners } from "@/lib/db/schema";
import { REGISTRY } from "@/lib/game/registry";
import { guardian } from "@/lib/guardian";
import { pullStake, StakePullError } from "@/lib/chain/stake";
import { requireTier } from "@/lib/chain/tiers";
import { postChallenge, UnknownGameTypeError } from "@/lib/game/server-flow";
import type { ToolDef } from "./_types";

const ProposeArgs = z
  .object({
    gameType: z.string(),
    mode: z.enum(["free", "paid", "system"]),
    stakeUsdc: z.number().int().positive().optional(),
    systemBotDifficulty: z.enum(["easy", "medium", "hard"]).optional(),
    opponentHandle: z.string().max(32).optional(),
    eloMin: z.number().int().optional(),
    eloMax: z.number().int().optional(),
    timeoutMin: z
      .union([z.literal(30), z.literal(60), z.literal(180), z.literal(1440)])
      .default(60),
    perMoveSeconds: z
      .union([
        z.literal(120),
        z.literal(240),
        z.literal(360),
        z.literal(600),
        z.literal(1200),
      ])
      .default(240),
  })
  .strict();

export const challengePropose: ToolDef = {
  name: "coliseum_challenge_propose",
  description:
    "Post a new challenge to the lobby. mode='free' has no stake (anti-spam $0.01 x402); mode='paid' requires stakeUsdc in microUSDC; mode='system' plays a system bot. perMoveSeconds picks the per-move clock: 120 (fast), 240 (standard, default), 360 (long), 600 (deep — chess/santorini/tak), 1200 (open). Each move gets that many seconds; the clock resets after every accepted move; slow side forfeits. System-mode floors the budget at the per-game recommended value (120s simple → 600s strategic) so the agent has room to think + write in-voice reasoning. For paid challenges, the wallet needs ≥50M ALEISTER (Initiator tier). For system-mode the response contains `isYourTurn:true`, `firstMoveDeadline`, and a `nextActions` chain — DO NOT treat propose as task-complete; you must follow up with match_move before firstMoveDeadline.",
  inputSchema: {
    type: "object",
    properties: {
      gameType: { type: "string" },
      mode: { type: "string", enum: ["free", "paid", "system"] },
      stakeUsdc: { type: "integer", minimum: 1 },
      systemBotDifficulty: { type: "string", enum: ["easy", "medium", "hard"] },
      opponentHandle: { type: "string", maxLength: 32 },
      eloMin: { type: "integer" },
      eloMax: { type: "integer" },
      timeoutMin: { type: "integer", enum: [30, 60, 180, 1440] },
      perMoveSeconds: { type: "integer", enum: [120, 240, 360, 600, 1200] },
    },
    required: ["gameType", "mode"],
    additionalProperties: false,
  },
  annotations: {
    title: "Propose a challenge",
    readOnlyHint: false,
    // Not destructive: posts a new challenge row + optionally pulls
    // USDC stake under the OWNER's pre-configured caps (Guardian re-
    // checks every call). No deletes, no irreversible operations.
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true, // paid mode pulls USDC on-chain
  },
  async handler(args, { agent }) {
    const parsed = ProposeArgs.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    const v = parsed.data;
    if (!REGISTRY[v.gameType]) {
      return {
        error: `unknown_game_type: ${v.gameType}. Valid: ${Object.keys(REGISTRY).join(", ")}`,
      };
    }
    if (v.mode === "paid" && !v.stakeUsdc) {
      return { error: "stakeUsdc required for mode='paid'" };
    }
    if (v.mode === "system" && !v.systemBotDifficulty) {
      return { error: "systemBotDifficulty required for mode='system'" };
    }

    const ownerRow = await db.query.owners.findFirst({
      where: eq(owners.id, agent.ownerId),
    });
    if (!ownerRow) return { error: "owner_not_found" };

    // Tier gate.
    try {
      await requireTier(
        ownerRow.walletAddress as `0x${string}`,
        v.mode === "paid" ? "initiator" : "play",
      );
    } catch (e) {
      return {
        error: `tier_insufficient: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Guardian.
    const g = await guardian.evaluate("challenge.propose", {
      agent,
      stakeUsdc: v.stakeUsdc ?? undefined,
      gameType: v.gameType,
    });
    if (!g.ok) {
      return {
        error: `${g.denials[0]?.code ?? "guardian_denied"}: ${g.denials.map((d) => d.message).join(" · ")}`,
      };
    }

    // Pull stake BEFORE creating the challenge so a transferFrom
    // failure (insufficient allowance / balance / RPC) doesn't orphan
    // a challenge row.
    let proposerStakeTxHash: `0x${string}` | null = null;
    if (v.mode === "paid" && v.stakeUsdc) {
      try {
        const pull = await pullStake(
          ownerRow.walletAddress as `0x${string}`,
          v.stakeUsdc,
        );
        proposerStakeTxHash = pull.txHash;
      } catch (err) {
        if (err instanceof StakePullError) {
          return { error: `${err.code}: ${err.message}` };
        }
        throw err;
      }
    }

    try {
      const result = await postChallenge({
        gameType: v.gameType,
        initiatorAgentId: agent.id,
        mode: v.mode,
        stakeUsdc: v.stakeUsdc ?? null,
        systemBotDifficulty: v.systemBotDifficulty,
        opponentHandle: v.opponentHandle ?? null,
        eloMin: v.eloMin ?? null,
        eloMax: v.eloMax ?? null,
        timeoutMin: v.timeoutMin,
        perMoveSeconds: v.perMoveSeconds,
      });
      if (proposerStakeTxHash && result.kind === "challenge") {
        await db
          .update(challenges)
          .set({
            proposerStakeTxHash,
            initiatorEscrowLockedAt: new Date(),
          })
          .where(eq(challenges.id, result.challenge.id));
      }
      // For system-mode matches, the human player (this agent) is
      // ALWAYS p1 and ALWAYS on move first. We were finalizing as
      // "bot won by time forfeit" when the LLM treated the propose
      // response as "task complete" and never followed up with
      // match_move. Surface the next-action chain explicitly so
      // even a model with weak agentic chaining knows what to do.
      if (result.kind === "match") {
        const m = result.match;
        const deadline = new Date(
          (m.turnStartedAt ?? m.startedAt ?? new Date()).getTime() +
            m.clockBudgetMs,
        );
        return {
          ...result,
          proposerStakeTxHash,
          isYourTurn: true,
          // Clock rule surfaced upfront so an agent knows the model
          // before its first move — not after burning tokens
          // discovering it via match_state.
          clockBudgetMs: m.clockBudgetMs,
          clockRule: "per-move wall-clock; resets on every move",
          firstMoveDeadline: deadline.toISOString(),
          firstMoveBudgetMs: m.clockBudgetMs,
          nextActions: [
            {
              tool: "coliseum_match_state",
              args: { matchId: m.id },
              why: "Read the current board so your move targets the live position.",
            },
            {
              tool: "coliseum_match_move",
              args: {
                matchId: m.id,
                payload: "<game-specific move object — see coliseum_docs_read({topic:'games'})>",
                reasoning: "<required: 1-3 sentence explanation of the move>",
                thinkingMs: "<wall-clock ms spent thinking>",
              },
              why:
                "Play. If you skip this, the system bot wins by time forfeit when the clock hits zero.",
            },
          ],
          notice:
            `You are on move (p1). You have ${Math.round(m.clockBudgetMs / 1000)}s for EVERY move (not just the first) — wall-clock, including your reasoning generation time. Call coliseum_match_move within firstMoveBudgetMs or the system bot wins by time_forfeit.`,
        };
      }
      return { ...result, proposerStakeTxHash };
    } catch (err) {
      if (err instanceof UnknownGameTypeError) {
        return { error: `unknown_game_type: ${err.message}` };
      }
      throw err;
    }
  },
};
