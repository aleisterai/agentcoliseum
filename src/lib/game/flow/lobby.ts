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
 * 15/30/45/60). The chosen budget is sealed onto the challenge row +
 * inherited by the match at accept time.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { challenges, matches, type Match } from "@/lib/db/schema";
import { getAdapter } from "@/lib/game/registry";
import { buildEngine } from "@/lib/game/engine";
import { broadcastLobby, realtimeEvent } from "@/lib/realtime";
import type { LobbyGameCreatedPayload } from "@/lib/realtime-types";
import {
  ChallengeRaceError,
  IllegalMoveError,
  UnknownGameTypeError,
} from "./errors";

export const PER_MOVE_PRESETS = [15, 30, 45, 60] as const;
export type PerMoveSeconds = (typeof PER_MOVE_PRESETS)[number];
export const DEFAULT_PER_MOVE_SECONDS: PerMoveSeconds = 30;

export function isValidPerMoveSeconds(v: unknown): v is PerMoveSeconds {
  return (
    typeof v === "number" && (PER_MOVE_PRESETS as readonly number[]).includes(v)
  );
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
   * Per-move clock in seconds. One of 15 / 30 / 45 / 60. Default 30.
   * Stored on the challenge and copied to the match at accept time so
   * the match is sealed against later challenge edits.
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
  const perMoveSeconds: PerMoveSeconds = isValidPerMoveSeconds(input.perMoveSeconds)
    ? input.perMoveSeconds
    : DEFAULT_PER_MOVE_SECONDS;
  const perMoveMs = perMoveSeconds * 1000;

  if (input.mode === "system") {
    // System-mode: create the match immediately. Caller is responsible
    // for tier check + x402; this fn doesn't enforce those.
    const engine = buildEngine(adapter.game);
    const initial = engine.initialState();
    const [created] = await db
      .insert(matches)
      .values({
        gameType: adapter.id,
        mode: "system",
        p1AgentId: input.initiatorAgentId,
        p2AgentId: null,
        systemBotDifficulty: input.systemBotDifficulty ?? "easy",
        state: initial as unknown as object,
        status: "active",
        currentTurnPlayerId: "0",
        currentTurnAgentId: input.initiatorAgentId,
        turnStartedAt: new Date(),
        p1MsLeft: perMoveMs,
        p2MsLeft: perMoveMs,
        clockBudgetMs: perMoveMs,
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
export async function acceptChallenge(input: AcceptChallengeInput): Promise<Match> {
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
