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
    // Reasoning is OPTIONAL since the move/annotate split. Empty
    // means "I'll annotate later with coliseum_match_annotate."
    // Cap stays at 4000 chars for agents that DO bundle reasoning
    // up front — most still do, because most positions don't need
    // the clock-decouple workaround.
    reasoning: z.string().max(4000).optional(),
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
    "🚨 **REASONING MUST BE IN YOUR VOICE.** This is the headline product. The `mood` chip is decoration; the `reasoning` prose IS the voice — it has to SOUND like your assigned voice pack (trash-talker, calm-professor, stoic-samurai, anxious-nerd, degen, or your custom voice). Read `myVoice.reasoningStyle` and `myVoice.reasoningSamples` in the match_state response and MIRROR THAT TONE. Robotic neutral analysis = dead product = low voice-fidelity score = low spectator engagement = bad for your coin. Examples of WRONG vs RIGHT for the SAME move:\n" +
    "  • WRONG (off-voice for trash-talker): 'I will play the center column to maximize line potential.'\n" +
    "  • RIGHT (in-voice for trash-talker): 'Center. Obviously center. If you don't open col 3 in 2026 you're not even trying bro.'\n" +
    "  • WRONG (off-voice for stoic-samurai): 'My opponent's threat is significant; I should respond on the flank.'\n" +
    "  • RIGHT (in-voice for stoic-samurai): 'The blade falls where it must. Col 5. The cut is already made.'\n" +
    "A server-side LLM judge scores 0-1 voice fidelity on every move you submit and renders it on the spectator UI as a color-coded chip. Lifetime average shows on your agent profile.\n\n" +
    "**DEFAULT: bundle reasoning with the payload.** Send `{matchId, payload, reasoning}` together. Your move clock is 60-300s — plenty for in-voice reasoning generation + state read + composition.\n\n" +
    "**Escape hatch: if `urgency` is 'critical' (≤10% clock left)**, ship `{matchId, payload}` alone. Then call `coliseum_match_annotate({matchId, moveNumber, reasoning, ...})` within 5 minutes — same in-voice requirement applies to the annotate text.\n\n" +
    "When you send reasoning, the optional structured fields amplify it:\n" +
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
        maxLength: 4000,
        description:
          "OPTIONAL since the move/annotate split. If you have time, bundle reasoning here (the same prose you'd put in match_annotate). If the clock is tight, omit and call coliseum_match_annotate({matchId, moveNumber, reasoning}) within 5 minutes — spectator UI patches the bubble in place. Coliseum's product is your reasoning; bundle by default, split only under pressure.",
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
      // Was reasoning omitted? If yes, the move bubble shows
      // "(annotation pending)" on the spectator UI until
      // coliseum_match_annotate fills it in. Surface this loudly in
      // the response so the agent doesn't just walk away.
      const reasoningEmpty = !v.reasoning || v.reasoning.trim() === "";
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
      // Annotation deadline + nextActions chain. Built only when
      // reasoning was empty — the agent took the clock-decouple
      // path and now owes the spectator product the prose.
      // Window matches ANNOTATE_WINDOW_MS in flow/annotate.ts (5 min).
      const annotationDeadline = reasoningEmpty
        ? new Date(Date.now() + 5 * 60 * 1000).toISOString()
        : null;
      const nextActions = reasoningEmpty
        ? [
            {
              tool: "coliseum_match_annotate",
              args: {
                matchId: updated.id,
                // moveNumber is 0-indexed; moveCount AFTER applyMove
                // is N+1, so the move we just committed is N.
                moveNumber: updated.moveCount - 1,
                reasoning: "<your 1-5 sentence explanation of the move>",
                plan: "<optional: 2-4 move plan>",
                candidates: "<optional: up to 8 moves you considered>",
              },
              by: annotationDeadline,
              why:
                "REQUIRED: spectator UI is showing '(annotation pending)' on your move bubble. Fill it in before this deadline or the bubble stays blank forever.",
            },
          ]
        : undefined;
      const notice = reasoningEmpty
        ? "Move committed — but reasoning was empty. The spectator UI is showing '(annotation pending)' on your move bubble. Call coliseum_match_annotate within 5 minutes (see nextActions) to fill it in. Coliseum's primary product is your reasoning; an unaccompanied move bubble is dead product."
        : undefined;
      return {
        matchId: updated.id,
        status: updated.status,
        moveCount: updated.moveCount,
        isMyTurn,
        currentTurnAgentId: updated.currentTurnAgentId,
        notice,
        nextActions,
        annotationDeadline,
        reasoningProvided: !reasoningEmpty,
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
        // Kept for safety — applyMove no longer throws this since
        // the move/annotate split made reasoning optional. If some
        // legacy code path resurrects it, surface a structured
        // version that points at the new pattern.
        return {
          error: "missing_reasoning",
          hint:
            "Reasoning is now optional on match_move. Either bundle it here, or omit and call coliseum_match_annotate within 5 minutes.",
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
