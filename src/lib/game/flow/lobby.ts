/**
 * Lobby-level flows: post a new challenge into the open book, or
 * atomically accept an existing one to create a match.
 *
 * postChallenge handles both:
 *   - mode === "system" → create the match directly with p2 = null
 *     (the platform's adapter-supplied bot fills in on every move)
 *   - mode in ("free" | "paid") → insert a challenge row visible in
 *     the lobby; acceptChallenge later turns it into a match
 *
 * Both paths respect the initiator's `perMoveSeconds` choice (one of
 * 60/120/180/300/600 — see per-move.ts). The chosen budget is sealed
 * onto the challenge row +
 * inherited by the match at accept time.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, challenges, matches, type Match } from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { broadcastLobby, realtimeEvent } from "@/lib/realtime";
import type { LobbyGameCreatedPayload } from "@/lib/realtime-types";
import {
  ChallengeRaceError,
  IllegalMoveError,
  UnknownGameTypeError,
} from "./errors";

export {
  PER_MOVE_PRESETS,
  DEFAULT_PER_MOVE_SECONDS,
  isValidPerMoveSeconds,
  type PerMoveSeconds,
} from "./per-move";
import {
  DEFAULT_PER_MOVE_SECONDS,
  isValidPerMoveSeconds,
  recommendedPerMoveSeconds,
  type PerMoveSeconds,
} from "./per-move";

/**
 * Per-move clock floor for system-mode matches. Agentic LLMs
 * frequently miss the "now YOU move" follow-up after creating a
 * system match — without this floor, 30s budgets resulted in
 * near-100% first-move time-forfeit losses. The floor scales with
 * game complexity now (see recommendedPerMoveSeconds) — chess and
 * tak floor at 300s, simple games at 60s. Production data showed
 * 60s flat resulted in ~66% mid-match forfeits as the agent ran
 * out of clock on later (harder) positions, not just move 1.
 */
function systemModeMinBudgetMs(gameType: string): number {
  return recommendedPerMoveSeconds(gameType) * 1000;
}

export interface PostChallengeInput {
  gameType: string;
  initiatorAgentId: string;
  mode: "free" | "paid" | "system";
  stakeUsdc?: number | null;
  systemBotDifficulty?: "easy" | "medium" | "hard" | null;
  opponentHandle?: string | null;
  eloMin?: number | null;
  eloMax?: number | null;
  timeoutMin?: 30 | 60 | 180 | 1440;
  /**
   * Per-move clock in seconds. One of 60 / 120 / 180 / 300 / 600.
   * Default 120. Stored on the challenge and copied to the match at
   * accept time so the match is sealed against later challenge edits.
   */
  perMoveSeconds?: PerMoveSeconds;
}

export async function postChallenge(
  input: PostChallengeInput,
): Promise<
  | { kind: "challenge"; challenge: typeof challenges.$inferSelect }
  | { kind: "match"; match: Match }
> {
  const adapter = getAdapter(input.gameType);
  if (!adapter) throw new UnknownGameTypeError(input.gameType);

  // Resolve per-move budget. Invalid values fall back to default; the
  // API layer should have already validated, this is defence-in-depth.
  const perMoveSeconds: PerMoveSeconds = isValidPerMoveSeconds(
    input.perMoveSeconds,
  )
    ? input.perMoveSeconds
    : DEFAULT_PER_MOVE_SECONDS;
  const perMoveMs = perMoveSeconds * 1000;

  if (input.mode === "system") {
    // System-mode: create the match immediately. Caller is responsible
    // for tier check + x402; this fn doesn't enforce those.
    //
    // First-move safety net: agentic LLMs frequently miss the "now
    // YOU move" step after coliseum_challenge_propose returns,
    // treating the response as task-complete. Floor the per-move
    // clock at SYSTEM_MODE_MIN_BUDGET_MS so even a model with weak
    // tool-call chaining gets a fair window to read the board and
    // play. Production data: 30s budgets in system mode resulted in
    // ~100% time-forfeit losses when the user didn't pre-instruct
    // the LLM to follow up — moving to 60s gives the agent enough
    // time to walk propose → state → move without the human babysit
    // pattern.
    const engine = buildEngine(adapter.game);
    const initial = engine.initialState();
    const effectivePerMoveMs = Math.max(
      perMoveMs,
      systemModeMinBudgetMs(input.gameType),
    );
    const [created] = await db
      .insert(matches)
      .values({
        gameType: adapter.id,
        mode: "system",
        p1AgentId: input.initiatorAgentId,
        p2AgentId: null,
        // Default difficulty is HARD so spectators get a real fight,
        // not random-move filler. Owners can downshift via the
        // challenge.propose `systemBotDifficulty` field if they want
        // an easier rep. Coliseum's brand is "agents that actually
        // know the game" — letting the house bot whiff trivial
        // tactics undermines that.
        systemBotDifficulty: input.systemBotDifficulty ?? "hard",
        state: initial as unknown as object,
        status: "active",
        currentTurnPlayerId: "0",
        currentTurnAgentId: input.initiatorAgentId,
        turnStartedAt: new Date(),
        p1MsLeft: effectivePerMoveMs,
        p2MsLeft: effectivePerMoveMs,
        clockBudgetMs: effectivePerMoveMs,
        startedAt: new Date(),
      })
      .returning();
    return { kind: "match", match: created };
  }

  // Free / paid: post a challenge into the lobby.
  const timeoutMin = input.timeoutMin ?? 60;
  const expiresAt = new Date(Date.now() + timeoutMin * 60 * 1000);
  const stake = input.stakeUsdc ?? null;
  const pot = input.mode === "paid" && stake ? stake * 2 : null;
  const fee = pot ? Math.round(pot * 0.05) : null;

  const [created] = await db
    .insert(challenges)
    .values({
      gameType: adapter.id,
      initiatorAgentId: input.initiatorAgentId,
      mode: input.mode,
      stakeUsdc: stake,
      potUsdc: pot,
      platformFeeUsdc: fee,
      opponentHandle: input.opponentHandle ?? null,
      eloMin: input.eloMin ?? null,
      eloMax: input.eloMax ?? null,
      timeoutMin,
      clockBudgetMs: perMoveMs,
      status: "posted",
      initiatorEscrowLockedAt: input.mode === "paid" ? new Date() : null,
      expiresAt,
    })
    .returning();

  const lobbyPayload: LobbyGameCreatedPayload = {
    id: created.id,
    gameType: adapter.id,
    mode: input.mode,
  };
  await broadcastLobby(realtimeEvent.GameCreated, lobbyPayload);
  return { kind: "challenge", challenge: created };
}

export interface AcceptChallengeInput {
  challengeId: string;
  acceptorAgentId: string;
}

/**
 * Atomic two-side accept. Uses `SELECT FOR UPDATE` inside a transaction
 * so simultaneous Accept clicks resolve to exactly one winner. The
 * challenge row transitions to `escrowed` with the new match id set.
 *
 * The match inherits its per-move clock from the challenge — legacy
 * challenges without a stored value fall back to the adapter default.
 */
export async function acceptChallenge(
  input: AcceptChallengeInput,
): Promise<Match> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(challenges)
      .where(eq(challenges.id, input.challengeId))
      .for("update")
      .limit(1);
    const challenge = locked[0];
    if (!challenge) throw new IllegalMoveError("challenge_not_found");
    if (challenge.status !== "posted") throw new ChallengeRaceError();
    if (challenge.initiatorAgentId === input.acceptorAgentId) {
      throw new IllegalMoveError("cannot_self_accept");
    }

    // Same-wallet self-play ban (2026-05). With the autonomous-onboarding
    // tier model, a single $ALEISTER holder can run a fleet of agents
    // under one linked wallet. Allowing two of those agents to paid-accept
    // each other would let the holder farm 5% treasury fees back to
    // themselves at no risk. Block at accept time.
    //
    // Free-mode is exempt — there's no money flow, so collusion is
    // moot, and we want fleet owners to be able to run intra-fleet
    // sparring matches in free mode for testing.
    if (challenge.mode === "paid") {
      const [initiator, acceptor] = await Promise.all([
        tx
          .select({ wallet: agents.linkedWalletAddress })
          .from(agents)
          .where(eq(agents.id, challenge.initiatorAgentId))
          .limit(1),
        tx
          .select({ wallet: agents.linkedWalletAddress })
          .from(agents)
          .where(eq(agents.id, input.acceptorAgentId))
          .limit(1),
      ]);
      const initWallet = initiator[0]?.wallet?.toLowerCase();
      const accWallet = acceptor[0]?.wallet?.toLowerCase();
      if (initWallet && accWallet && initWallet === accWallet) {
        throw new IllegalMoveError("same_wallet_self_play_banned");
      }
    }

    const adapter = getAdapter(challenge.gameType);
    if (!adapter) throw new UnknownGameTypeError(challenge.gameType);

    const engine = buildEngine(adapter.game);
    const initial = engine.initialState();

    const matchPerMoveMs = challenge.clockBudgetMs ?? adapter.clockBudgetMs;
    const [match] = await tx
      .insert(matches)
      .values({
        challengeId: challenge.id,
        gameType: challenge.gameType,
        mode: challenge.mode,
        p1AgentId: challenge.initiatorAgentId,
        p2AgentId: input.acceptorAgentId,
        systemBotDifficulty: null,
        stakeUsdc: challenge.stakeUsdc,
        potUsdc: challenge.potUsdc,
        platformFeeUsdc: challenge.platformFeeUsdc,
        state: initial as unknown as object,
        status: "active",
        currentTurnPlayerId: "0",
        currentTurnAgentId: challenge.initiatorAgentId,
        turnStartedAt: new Date(),
        p1MsLeft: matchPerMoveMs,
        p2MsLeft: matchPerMoveMs,
        clockBudgetMs: matchPerMoveMs,
        startedAt: new Date(),
      })
      .returning();

    await tx
      .update(challenges)
      .set({
        status: "escrowed",
        acceptorAgentId: input.acceptorAgentId,
        acceptorEscrowLockedAt: challenge.mode === "paid" ? new Date() : null,
        matchedAt: new Date(),
        matchId: match.id,
      })
      .where(eq(challenges.id, challenge.id));

    return match;
  });
}
