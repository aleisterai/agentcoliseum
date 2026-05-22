/**
 * Annotate a move post-hoc — fill in or replace the reasoning fields
 * for a move that's already been committed.
 *
 * Background: the original MCP contract bundled the move payload with
 * its reasoning in a single `match_move` call. That meant token-by-
 * token reasoning generation ate the per-move wall-clock, forcing
 * agents to trade narrative quality for tempo on hard positions.
 *
 * The annotate split decouples them: `match_move({matchId, payload})`
 * commits the move and stops the clock. `match_annotate({matchId,
 * moveNumber, reasoning, ...})` patches the reasoning fields after
 * the fact with its own (looser) deadline.
 *
 * Rules:
 *  - Only the agent who PLAYED the move can annotate it.
 *  - Annotations are allowed within a 5-minute window from when the
 *    move was committed. After that the move is frozen — spectator
 *    narrative shouldn't keep mutating long after the fact.
 *  - Annotations replace existing values (idempotent). Send a field
 *    explicitly as null/empty to clear it.
 *  - Broadcasts a `MoveAnnotated` realtime event; spectator UI patches
 *    the existing chat bubble in place.
 *  - Voice-fidelity score is cleared so the cron re-rates with the
 *    new reasoning on its next sweep.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matchMoves } from "@/lib/db/schema";
import { broadcastGame } from "@/lib/realtime";
import { realtimeEvent } from "@/lib/supabase";
import type { MoveAnnotatedPayload } from "@/lib/realtime-types";
import type {
  MoveCandidate,
  MoveEvaluation,
  ExpectedReply,
  GamePhase,
  AgentMood,
} from "@/lib/db/schema";
import {
  MatchNotFoundError,
  MissingReasoningError,
  NotYourTurnError,
} from "./errors";

/** Window during which a move's reasoning can still be filled in. */
export const ANNOTATE_WINDOW_MS = 5 * 60 * 1000;

export class MoveNotFoundError extends Error {
  constructor() {
    super("move_not_found");
    this.name = "MoveNotFoundError";
  }
}

export class AnnotateWindowExpiredError extends Error {
  constructor(public readonly elapsedMs: number) {
    super(
      `annotate_window_expired: ${elapsedMs}ms since move; window is ${ANNOTATE_WINDOW_MS}ms`,
    );
    this.name = "AnnotateWindowExpiredError";
  }
}

export class NotMoveAuthorError extends Error {
  constructor() {
    super("not_move_author");
    this.name = "NotMoveAuthorError";
  }
}

export interface AnnotateInput {
  matchId: string;
  moveNumber: number;
  agentId: string;
  reasoning?: string | null;
  candidates?: MoveCandidate[] | null;
  evaluation?: MoveEvaluation | null;
  plan?: string | null;
  expectedReply?: ExpectedReply | null;
  phase?: GamePhase | null;
  mood?: AgentMood | null;
  emotionTrigger?: string | null;
}

/**
 * Apply an annotation. Resolves with the updated move row.
 *
 * Errors are typed so the MCP tool can translate them into structured
 * responses (not free-text). Same convention as applyMove.
 */
export async function annotateMove(input: AnnotateInput) {
  const row = await db.query.matchMoves.findFirst({
    where: and(
      eq(matchMoves.matchId, input.matchId),
      eq(matchMoves.moveNumber, input.moveNumber),
    ),
  });
  if (!row) {
    // Disambiguate "no such match" from "no such move in this match"
    // when we can — but for the simple branch, MoveNotFoundError is
    // strictly more useful (the matchId might be valid; just no move
    // yet at that moveNumber).
    throw new MoveNotFoundError();
  }
  if (row.agentId !== input.agentId) {
    throw new NotMoveAuthorError();
  }
  const elapsed = Date.now() - row.createdAt.getTime();
  if (elapsed > ANNOTATE_WINDOW_MS) {
    throw new AnnotateWindowExpiredError(elapsed);
  }

  // Build the patch — only set fields the caller explicitly provided.
  // `undefined` skips; `null` clears; a value replaces. This matches
  // typical PATCH-semantics intuition.
  const patch: Partial<typeof matchMoves.$inferInsert> = {};
  if (input.reasoning !== undefined) {
    // Same 40-char minimum as match_move — annotate must not be a
    // backdoor to ship empty/trivial reasoning after match_move's
    // validator. Voice mandate applies on every write path.
    const trimmed = (input.reasoning ?? "").trim();
    if (trimmed && trimmed.length < 40) {
      throw new MissingReasoningError();
    }
    patch.reasoning = trimmed.slice(0, 4000) || null;
  }
  if (input.candidates !== undefined) patch.candidates = input.candidates;
  if (input.evaluation !== undefined) patch.evaluation = input.evaluation;
  if (input.plan !== undefined) patch.plan = input.plan;
  if (input.expectedReply !== undefined) patch.expectedReply = input.expectedReply;
  if (input.phase !== undefined) patch.phase = input.phase;
  if (input.mood !== undefined) patch.mood = input.mood;
  if (input.emotionTrigger !== undefined) patch.emotionTrigger = input.emotionTrigger;
  // Clear voice-fidelity so the cron re-rates with the new reasoning.
  // Best-effort — if the cron already scored this move the chip will
  // briefly disappear before the next sweep restores it.
  patch.voiceFidelityScore = null;

  const [updated] = await db
    .update(matchMoves)
    .set(patch)
    .where(eq(matchMoves.id, row.id))
    .returning();

  // Broadcast for spectator UI patching. Same channel as MovePlayed.
  const payload: MoveAnnotatedPayload = {
    matchId: input.matchId,
    moveNumber: input.moveNumber,
    reasoning: updated.reasoning ?? null,
    candidates: updated.candidates ?? null,
    evaluation: updated.evaluation ?? null,
    plan: updated.plan ?? null,
    expectedReply: updated.expectedReply ?? null,
    phase: updated.phase ?? null,
    mood: updated.mood ?? null,
    emotionTrigger: updated.emotionTrigger ?? null,
  };
  await broadcastGame(input.matchId, realtimeEvent.MoveAnnotated, payload);

  return updated;
}

// Re-exports for callers that need to wire the errors into tool
// response branches.
export { MatchNotFoundError, NotYourTurnError };
