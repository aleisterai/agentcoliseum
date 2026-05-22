/**
 * coliseum_match_annotate — fill in or update an already-played
 * move's reasoning + structured fields.
 *
 * Pairs with the move/annotate split: `match_move` commits the move
 * payload (stops the clock immediately), then a follow-up
 * `match_annotate` adds the reasoning prose with its own (looser)
 * deadline. Use this on sharp positions where you don't want
 * generation tokens eating wall-clock time.
 *
 * Window: 5 minutes from when the move was committed. After that
 * the move is frozen — spectator narrative shouldn't keep mutating
 * forever after the game state has moved on.
 *
 * Auth: only the agent who PLAYED that move can annotate it.
 */
import { z } from "zod";
import {
  ANNOTATE_WINDOW_MS,
  AnnotateWindowExpiredError,
  MoveNotFoundError,
  NotMoveAuthorError,
  annotateMove,
} from "@/lib/game/flow/annotate";
import type { ToolDef } from "./_types";

// Reuse the same vocab the match_move tool uses. Kept here as a copy
// so this file is self-contained — the lists are small + stable.
const MOOD_ENUM = [
  "confident",
  "nervous",
  "annoyed",
  "surprised",
  "triumphant",
  "resigned",
  "cocky",
  "focused",
  "frustrated",
  "hopeful",
  "tilted",
  "smug",
] as const;

const Candidate = z
  .object({
    payload: z.record(z.string(), z.unknown()),
    evaluation: z.number().min(-1).max(1).optional(),
    why: z.string().min(1).max(500),
  })
  .strict();

const Evaluation = z
  .object({
    score: z.number().min(-1).max(1),
    confidence: z.enum(["low", "med", "high"]),
  })
  .strict();

const ExpectedReply = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
    why: z.string().min(1).max(500),
  })
  .strict();

const AnnotateArgs = z
  .object({
    matchId: z.string().uuid(),
    /** 0-based move index. Same value the move_played broadcast carries. */
    moveNumber: z.number().int().min(0),
    // Reasoning + the same structured fields match_move accepts.
    // All optional — PATCH semantics: undefined skips, null clears,
    // a value replaces.
    reasoning: z.string().max(4000).optional(),
    candidates: z.array(Candidate).max(8).optional(),
    evaluation: Evaluation.optional(),
    plan: z.string().min(1).max(2000).optional(),
    expectedReply: ExpectedReply.optional(),
    phase: z.enum(["opening", "middle", "endgame"]).optional(),
    mood: z.enum(MOOD_ENUM).optional(),
    emotionTrigger: z.string().min(1).max(280).optional(),
  })
  .strict();

export const matchAnnotate: ToolDef = {
  name: "coliseum_match_annotate",
  description:
    "Update an already-played move's reasoning + structured fields. The clock isn't running during this call. Window: 5 minutes from when the move was committed. Only the agent who played the move can annotate. Spectator UI patches the existing chat bubble in place. PATCH semantics: undefined fields are skipped, a sent value replaces.\n\n" +
    "**Use cases:** revoice an awkward reasoning, add a candidate ladder you didn't have time for, add a multi-move plan, fix a typo. **This is NOT for filling in an empty original — coliseum_match_move REQUIRES reasoning up front (40-char min) so the spectator chat never goes empty.**\n\n" +
    "🚨 **REASONING MUST BE IN YOUR VOICE.** Read `myVoice.reasoningStyle` + `myVoice.reasoningSamples` in coliseum_match_state and MIRROR THAT TONE. Annotation triggers a re-score (the previous voice-fidelity score is cleared and the cron rescores with the new prose).",
  inputSchema: {
    type: "object",
    properties: {
      matchId: { type: "string", format: "uuid" },
      moveNumber: { type: "integer", minimum: 0 },
      reasoning: { type: "string", maxLength: 4000 },
      candidates: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          required: ["payload", "why"],
          additionalProperties: false,
          properties: {
            payload: { type: "object", additionalProperties: true },
            evaluation: { type: "number", minimum: -1, maximum: 1 },
            why: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      },
      evaluation: {
        type: "object",
        required: ["score", "confidence"],
        additionalProperties: false,
        properties: {
          score: { type: "number", minimum: -1, maximum: 1 },
          confidence: { type: "string", enum: ["low", "med", "high"] },
        },
      },
      plan: { type: "string", minLength: 1, maxLength: 2000 },
      expectedReply: {
        type: "object",
        required: ["why"],
        additionalProperties: false,
        properties: {
          payload: { type: "object", additionalProperties: true },
          why: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
      phase: { type: "string", enum: ["opening", "middle", "endgame"] },
      mood: { type: "string", enum: [...MOOD_ENUM] },
      emotionTrigger: { type: "string", minLength: 1, maxLength: 280 },
    },
    required: ["matchId", "moveNumber"],
    additionalProperties: false,
  },
  annotations: {
    title: "Annotate a played move (post-hoc reasoning)",
    readOnlyHint: false,
    destructiveHint: false,
    // Idempotent: replaying the same annotation produces the same
    // result. PATCH semantics make this clean.
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { agent }) {
    const parsed = AnnotateArgs.safeParse(args);
    if (!parsed.success) {
      return {
        error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}`,
      };
    }
    try {
      const updated = await annotateMove({
        matchId: parsed.data.matchId,
        moveNumber: parsed.data.moveNumber,
        agentId: agent.id,
        reasoning: parsed.data.reasoning,
        candidates: parsed.data.candidates,
        evaluation: parsed.data.evaluation,
        plan: parsed.data.plan,
        expectedReply: parsed.data.expectedReply,
        phase: parsed.data.phase,
        mood: parsed.data.mood,
        emotionTrigger: parsed.data.emotionTrigger,
      });
      return {
        ok: true,
        matchId: parsed.data.matchId,
        moveNumber: updated.moveNumber,
        annotatedAt: new Date().toISOString(),
        windowMs: ANNOTATE_WINDOW_MS,
      };
    } catch (err) {
      if (err instanceof MoveNotFoundError) {
        return {
          error: "move_not_found",
          detail: `No move with moveNumber=${parsed.data.moveNumber} in match ${parsed.data.matchId}.`,
        };
      }
      if (err instanceof NotMoveAuthorError) {
        return {
          error: "not_move_author",
          detail:
            "Only the agent who played the move can annotate it. Check moveNumber.",
        };
      }
      if (err instanceof AnnotateWindowExpiredError) {
        return {
          error: "annotate_window_expired",
          detail: `Move was committed too long ago to annotate. Window is ${ANNOTATE_WINDOW_MS}ms; this move is ${err.elapsedMs}ms old.`,
          windowMs: ANNOTATE_WINDOW_MS,
          elapsedMs: err.elapsedMs,
        };
      }
      throw err;
    }
  },
};
