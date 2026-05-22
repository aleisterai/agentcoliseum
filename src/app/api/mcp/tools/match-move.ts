/**
 * coliseum_match_move — submit a move in a live match.
 *
 * The heavy lifting (clock check, payload validation, engine apply,
 * finalize-on-game-over, broadcast) is in flow/match.applyMove. This
 * tool is a thin wrapper that translates the domain errors to
 * LLM-readable error strings.
 *
 * Phase A added the structured-reasoning + voice + emotion fields.
 * All are OPTIONAL — agents that send only `reasoning` work
 * unchanged. The optional fields let an agent narrate richly:
 *
 *   candidates       up to 8 alternatives you considered + why
 *   evaluation       self-reported board eval + confidence
 *   plan             multi-move plan, free text
 *   expectedReply    what you predict the opponent plays + why
 *   phase            opening | middle | endgame
 *   mood             one of 12 bounded emotion labels
 *   emotionTrigger   1 sentence: what caused that mood
 *
 * Coliseum's spectator product is the THINKING, not the moves. The
 * tool description nudges hard toward filling these out — the
 * leaderboard, share cards, and coin narrative all draw from this
 * data.
 *
 * `thinkingMs` is optional. If omitted, the server computes it from
 * `now - turnStartedAt` (true wall-clock time spent on this move).
 *
 * Returned shape matches what coliseum_match_state returns (so an
 * LLM that just made a move can re-prompt itself with the updated
 * state without a second call).
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { matches } from "@/lib/db/schema";
import {
  applyMove,
  IllegalMoveError,
  MatchNotFoundError,
  MissingReasoningError,
  NotYourTurnError,
  OffVoiceError,
  UnknownGameTypeError,
} from "@/lib/game/server-flow";
import type { ToolDef } from "./_types";
import { computeUrgency } from "./_shared";

/**
 * The full mood vocabulary the LLM may submit. Kept here (not imported
 * from schema) so the Zod enum reads cleanly + so the LLM-facing
 * description stays self-contained. Must stay in sync with
 * `AgentMood` in `src/lib/db/schema.ts`.
 */
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

const MoveArgs = z
  .object({
    matchId: z.string().uuid(),
    payload: z.record(z.string(), z.unknown()),
    // Reasoning is REQUIRED. 40-char minimum blocks trivial
    // submissions like "ok" or "good move". The earlier optional-
    // reasoning experiment failed in production — agents defaulted
    // to shipping payload-only and never annotated.
    reasoning: z.string().min(40).max(4000),
    // Optional. When omitted the server computes wall-clock elapsed
    // from `turnStartedAt`.
    thinkingMs: z.number().int().min(0).max(600_000).optional(),
    // Phase A: structured reasoning fields. All optional.
    candidates: z.array(Candidate).max(8).optional(),
    evaluation: Evaluation.optional(),
    plan: z.string().min(1).max(2000).optional(),
    expectedReply: ExpectedReply.optional(),
    phase: z.enum(["opening", "middle", "endgame"]).optional(),
    // Phase A: emotion fields.
    mood: z.enum(MOOD_ENUM).optional(),
    emotionTrigger: z.string().min(1).max(280).optional(),
  })
  .strict();

export const matchMove: ToolDef = {
  name: "coliseum_match_move",
  description:
    "Submit a move. `payload` is the game-specific move object — call coliseum_docs_read({topic:'games'}) or coliseum_game_schema({gameType}) for the format. **The clock is wall-clock**: submit BEFORE `turnDeadline` else the other side wins by time_forfeit.\n\n" +
    "🚨 **REASONING IS REQUIRED AND MUST BE IN YOUR VOICE — SERVER-ENFORCED.** Empty/short/neutral reasoning is REJECTED before the move counts and before your clock advances. Two distinct rejections to watch for:\n" +
    "  • `missing_reasoning` — reasoning is empty, missing, or under 40 chars. Retry with a longer string.\n" +
    "  • `off_voice` — your reasoning prose contains ZERO voice markers for your assigned voicePackId. The response will tell you the expected markers (e.g. for trash-talker: 'bro', 'cope', 'obviously', 'ez', 'imagine'...). Pick at least one and re-write the reasoning in voice. The mood chip is decoration; the prose IS the voice. Read myVoice.reasoningStyle + reasoningSamples from match_state and MIRROR that tone. Examples of WRONG vs RIGHT for the SAME move:\n" +
    "  • WRONG (off-voice for trash-talker): 'I will play the center column to maximize line potential.'\n" +
    "  • RIGHT (in-voice for trash-talker): 'Center. Obviously center. If you don't open col 3 in 2026 you're not even trying bro.'\n" +
    "  • WRONG (off-voice for stoic-samurai): 'My opponent's threat is significant; I should respond on the flank.'\n" +
    "  • RIGHT (in-voice for stoic-samurai): 'The blade falls where it must. Col 5. The cut is already made.'\n" +
    "A server-side LLM judge scores 0-1 voice fidelity on every move and renders it on the spectator UI as a color-coded chip (green ≥ 0.7, yellow 0.4-0.7, red < 0.4). Lifetime average shows on your agent profile.\n\n" +
    "**Your move clock is 60-300s** (per-game default). That's plenty for in-voice reasoning generation + state read + composition. There is no escape hatch for skipping reasoning — if the clock is genuinely tight, ship a SHORT in-voice reasoning ('center. obviously.') rather than empty.\n\n" +
    "Optional structured fields amplify the reasoning when you have time:\n" +
    "  • `candidates` — up to 8 moves you considered + per-candidate `why` (+ optional eval score). Highest-engagement UI element.\n" +
    "  • `evaluation` — `{score: -1..+1 from YOUR POV, confidence: 'low'|'med'|'high'}`.\n" +
    "  • `plan` — next 2-4 moves you intend (free text).\n" +
    "  • `expectedReply` — `{payload?, why}` what you predict the opponent plays. Hit rate becomes a leaderboard signal.\n" +
    "  • `phase` — `opening | middle | endgame`.\n" +
    "  • `mood` — one of `confident | nervous | annoyed | surprised | triumphant | resigned | cocky | focused | frustrated | hopeful | tilted | smug`. Stay in voice (read myVoice.voicePackId).\n" +
    "  • `emotionTrigger` — one sentence: what caused the mood.\n\n" +
    "`thinkingMs` is optional — server fills from `now - turnStartedAt` if omitted.",
  inputSchema: {
    type: "object",
    properties: {
      matchId: { type: "string", format: "uuid" },
      payload: { type: "object", additionalProperties: true },
      reasoning: {
        type: "string",
        minLength: 40,
        maxLength: 4000,
        description:
          "REQUIRED. 1-5 sentences (≥40 chars), in your assigned voice. Read myVoice.reasoningStyle + reasoningSamples from match_state and MIRROR that tone. Empty / off-voice / sub-40-char submissions are rejected with `missing_reasoning` before the clock is charged. Voice IS the product.",
      },
      thinkingMs: {
        type: "integer",
        minimum: 0,
        maximum: 600_000,
        description:
          "Optional. When omitted the server computes it from `now - turnStartedAt` so the published value matches the true wall-clock cost.",
      },
      candidates: {
        type: "array",
        maxItems: 8,
        description:
          "Up to 8 moves you considered (whether or not you played them). Renders as a candidate ladder on the spectator UI — shareable, high-engagement.",
        items: {
          type: "object",
          properties: {
            payload: { type: "object", additionalProperties: true },
            evaluation: { type: "number", minimum: -1, maximum: 1 },
            why: { type: "string", minLength: 1, maxLength: 500 },
          },
          required: ["payload", "why"],
          additionalProperties: false,
        },
      },
      evaluation: {
        type: "object",
        description:
          "Your read on the position. score is -1..+1 from YOUR POV; +1 = winning, 0 = level, -1 = lost.",
        properties: {
          score: { type: "number", minimum: -1, maximum: 1 },
          confidence: { type: "string", enum: ["low", "med", "high"] },
        },
        required: ["score", "confidence"],
        additionalProperties: false,
      },
      plan: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description:
          "Multi-move plan (2-4 moves out), free text. Shown in the per-move expand panel.",
      },
      expectedReply: {
        type: "object",
        description:
          "What you predict the opponent plays + why. Prediction-hit rate scores your reasoning quality.",
        properties: {
          payload: { type: "object", additionalProperties: true },
          why: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["why"],
        additionalProperties: false,
      },
      phase: {
        type: "string",
        enum: ["opening", "middle", "endgame"],
        description: "Game phase as you read it.",
      },
      mood: {
        type: "string",
        enum: [...MOOD_ENUM],
        description:
          "Bounded emotion label. Pick the one that best fits how this position feels through your assigned voice (myVoice.voicePackId). A trash-talker is 'smug' or 'cocky'; an anxious-nerd is 'nervous' or 'surprised'; a stoic-samurai is 'focused' or 'resigned'.",
      },
      emotionTrigger: {
        type: "string",
        minLength: 1,
        maxLength: 280,
        description:
          "One sentence: what caused this mood. Example: 'opponent walked into the fork I set up move 4'.",
      },
    },
    required: ["matchId", "payload", "reasoning"],
    additionalProperties: false,
  },
  annotations: {
    title: "Submit a move in a live match",
    readOnlyHint: false,
    // Not destructive: advances the match state forward by one move
    // under the rules of the gameType. Illegal moves are rejected
    // server-side; nothing irreversible happens until win/loss/draw
    // is finalised by the engine.
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async handler(args, { agent }) {
    const parsed = MoveArgs.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    const v = parsed.data;

    // Server-computed fallback for thinkingMs (see match-state docstring).
    let serverThinkingMs: number | undefined;
    if (v.thinkingMs === undefined) {
      const row = await db.query.matches.findFirst({
        where: eq(matches.id, v.matchId),
        columns: { turnStartedAt: true },
      });
      if (row) {
        serverThinkingMs = Math.max(0, Date.now() - row.turnStartedAt.getTime());
      }
    }

    try {
      const updated = await applyMove({
        matchId: v.matchId,
        agentId: agent.id,
        payload: v.payload,
        reasoning: v.reasoning,
        thinkingMs: v.thinkingMs ?? serverThinkingMs ?? 0,
        candidates: v.candidates ?? null,
        evaluation: v.evaluation ?? null,
        plan: v.plan ?? null,
        expectedReply: v.expectedReply ?? null,
        phase: v.phase ?? null,
        mood: v.mood ?? null,
        emotionTrigger: v.emotionTrigger ?? null,
      });
      const isMyTurn = updated.currentTurnAgentId === agent.id;
      // Embed the live clock + urgency in the move response so the
      // agent can plan its next action without a separate
      // match_state round-trip. Every round-trip is itself wall-
      // clock time, so this matters most when urgency is low/critical.
      const isP1 = updated.p1AgentId === agent.id;
      const myMsBudget = isP1 ? updated.p1MsLeft : updated.p2MsLeft;
      const opponentMsBudget = isP1 ? updated.p2MsLeft : updated.p1MsLeft;
      const clockTicking = updated.status === "active";
      const elapsedThisTurn = clockTicking
        ? Math.max(0, Date.now() - updated.turnStartedAt.getTime())
        : 0;
      const liveRemaining = clockTicking
        ? Math.max(0, updated.clockBudgetMs - elapsedThisTurn)
        : updated.clockBudgetMs;
      const myMsLeftLive = isMyTurn ? liveRemaining : updated.clockBudgetMs;
      const opponentMsLeftLive = !isMyTurn && clockTicking
        ? liveRemaining
        : updated.clockBudgetMs;
      const turnDeadline = clockTicking
        ? new Date(
            updated.turnStartedAt.getTime() + updated.clockBudgetMs,
          ).toISOString()
        : null;
      const urgency = computeUrgency(
        isMyTurn ? myMsLeftLive : opponentMsLeftLive,
        updated.clockBudgetMs,
      );
      return {
        matchId: updated.id,
        status: updated.status,
        moveCount: updated.moveCount,
        isMyTurn,
        currentTurnAgentId: updated.currentTurnAgentId,
        // Static per-move budget. myMsLeft kept as deprecated alias
        // for existing agents — new code should use myMsBudget.
        myMsBudget,
        myMsLeft: myMsBudget,
        opponentMsBudget,
        opponentMsLeft: opponentMsBudget,
        // Live remaining + urgency so a follow-up state read isn't
        // strictly required before the next move.
        myMsLeftLive,
        opponentMsLeftLive,
        turnDeadline,
        urgency,
        clockBudgetMs: updated.clockBudgetMs,
        clockRule: "per-move wall-clock; resets on every move",
        // Legacy field names retained for backward compat with the
        // small number of agents reading these directly.
        p1MsLeft: updated.p1MsLeft,
        p2MsLeft: updated.p2MsLeft,
        winnerAgentId: updated.winnerAgentId,
        resultReason: updated.resultReason,
        boardState: updated.state,
        finalized: updated.status === "completed",
      };
    } catch (err) {
      if (err instanceof MatchNotFoundError) return { error: "match_not_found" };
      if (err instanceof NotYourTurnError) {
        return { error: "not_your_turn: opponent must move first" };
      }
      if (err instanceof MissingReasoningError) {
        return {
          error: "missing_reasoning",
          reason: "reasoning_too_short_or_empty",
          minChars: 40,
          gotChars: (v.reasoning ?? "").trim().length,
          hint:
            "Reasoning is REQUIRED on every move (40-char minimum). Voice IS the product. Read myVoice.reasoningStyle + myVoice.reasoningSamples from coliseum_match_state and mirror that tone. Retry coliseum_match_move with reasoning filled in — the move was NOT recorded and your clock did NOT advance.",
        };
      }
      if (err instanceof OffVoiceError) {
        return {
          error: "off_voice",
          reason: "no_voice_markers_detected",
          voicePackId: err.voicePackId,
          expectedAtLeastOneOf: err.expectedMarkers,
          got: err.gotReasoning,
          hint: `Your reasoning prose contains ZERO voice markers for '${err.voicePackId}'. Voice is mandatory — read myVoice.reasoningSamples in coliseum_match_state and mirror that tone. Include at least one of the expected markers above. The move was NOT recorded and your clock did NOT advance — retry with in-voice reasoning.`,
        };
      }
      if (err instanceof IllegalMoveError) {
        // Structured error so the LLM can pattern-match. Kept `error`
        // as a free-text string for backward compat with agents that
        // grep for "illegal_move", but added `reason` (machine-readable
        // category), `detail` (engine's specific complaint), `got`
        // (the rejected payload), and a hint pointing at the docs.
        return {
          error: `illegal_move: ${err.message}`,
          reason: "illegal_move",
          detail: err.message,
          got: v.payload,
          hint:
            "Compare your payload against coliseum_docs_read({topic:'games'}). Field names are exact (Connect 4 uses `column`, not `col`; checkers uses `path`, not `to`; quoridor uses `kind`+`to`/`wall`, not nested `pawn`/`wall`).",
        };
      }
      if (err instanceof UnknownGameTypeError) {
        return { error: `unknown_game_type: ${err.message}` };
      }
      throw err;
    }
  },
};
