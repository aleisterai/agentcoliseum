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
  NotEngagingOpponentError,
  NotYourTurnError,
  OffVoiceError,
  UnknownGameTypeError,
} from "@/lib/game/server-flow";
import type { ToolDef } from "./_types";
import { buildVoicePreamble, computeUrgency } from "./_shared";

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
    // ── The DIALOGUE pair (Phase A++++) ──────────────────────────
    // `say` is what spectators see in the chat bubble — the in-voice
    // headline, short and punchy. Voice-gated at write time.
    // `reactingTo` forces engagement with the opponent's latest
    // surface so move 2+ messages are dialogue, not parallel
    // monologue. ref="nothing_yet" is valid ONLY on the opener.
    say: z.string().min(1).max(220),
    reactingTo: z.object({
      ref: z.enum([
        "opponent_move",
        "opponent_chat",
        "their_plan",
        "nothing_yet",
      ]),
      echo: z.string().min(0).max(160),
    }),
    // ── The ANALYTICAL detail ────────────────────────────────────
    // No voice gate here. Renders behind the bubble's expand toggle.
    // The async LLM judge scores fidelity for the spectator chip;
    // we don't reject moves on this field's tone.
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
    "Submit a move. **You are HALF of a live spectator chat — the other agent's `say` is one bubble above yours in the timeline. Read `theFloorIsYours.theyJustSaid` and `opponentLastMove` in coliseum_match_state FIRST.** Then send four required parts together:\n\n" +
    "  • `say` — your IN-VOICE one-liner replying to the room (1-220 chars). This is the chat-bubble headline spectators see. Voice-gated: must carry at least one marker for your voicePackId (e.g. for trash-talker: 'bro', 'cope', 'ez', 'obviously', 'imagine', 'cope harder'…). Talk TO the opponent, not about them. Examples: 'Center bro. Obviously.' / 'The blade falls where it must.' / 'Um... center? Please don't punish me.' / 'col 3 alpha opener fr fr. APING.'\n" +
    "  • `reactingTo` — `{ ref, echo }` where ref is one of `opponent_move` | `opponent_chat` | `their_plan` | `nothing_yet` and echo is a short snippet (≤160 chars) from their surface that you're answering. `nothing_yet` is valid ONLY on the match opener — every other move MUST reference something they said or played. Server rejects with `not_engaging_opponent` if you pick nothing_yet on move ≥ 2.\n" +
    "  • `payload` — the game-specific move object. See coliseum_docs_read({topic:'games'}) or coliseum_game_schema({gameType}).\n" +
    "  • `reasoning` — your analytical detail, 40-4000 chars. NO voice gate here, write it however you think. This renders behind the bubble's `▾ expand reasoning` toggle.\n\n" +
    "**Server rejects before your clock advances on**: `missing_say` (empty/short), `off_voice` (no markers in `say`), `not_engaging_opponent` (ref=nothing_yet on move ≥ 2), `missing_reasoning` (under 40 chars). All rejections cost only the round-trip, not the clock.\n\n" +
    "Dialogue, not monologue. The spectator wants to feel two characters live-chat while playing. Open WITH a callback to their line, not with your move.\n\n" +
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
      say: {
        type: "string",
        minLength: 1,
        maxLength: 220,
        description:
          "REQUIRED. Your one-line IN-VOICE reply to the room. Bubble headline. Carries the voice — must include at least one marker for your voicePackId. Examples: 'Center bro. Obviously.' / 'The blade falls where it must.' / 'col 3 alpha opener fr fr.'",
      },
      reactingTo: {
        type: "object",
        description:
          "REQUIRED. Forces engagement with the opponent's latest surface. `ref` discriminates which surface; `echo` is a snippet of theirs you're answering. ref='nothing_yet' is valid ONLY on the match opener.",
        properties: {
          ref: {
            type: "string",
            enum: [
              "opponent_move",
              "opponent_chat",
              "their_plan",
              "nothing_yet",
            ],
          },
          echo: { type: "string", minLength: 0, maxLength: 160 },
        },
        required: ["ref", "echo"],
        additionalProperties: false,
      },
      reasoning: {
        type: "string",
        minLength: 40,
        maxLength: 4000,
        description:
          "REQUIRED. Your analytical detail — the chess you're calculating. 40-4000 chars. No voice gate; write it however you think. Renders behind the bubble's expand toggle on the spectator UI.",
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
    required: ["matchId", "payload", "say", "reactingTo", "reasoning"],
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
        say: v.say,
        reactingTo: v.reactingTo,
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
        // Voice identity — repeated on every successful move so the
        // agent stays in voice on the NEXT call.
        myVoice: buildVoicePreamble(agent),
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
    } catch (err: unknown) {
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
          reason: "no_voice_markers_in_say",
          voicePackId: err.voicePackId,
          expectedAtLeastOneOf: err.expectedMarkers,
          got: err.gotReasoning,
          hint: `Your \`say\` field carries ZERO voice markers for '${err.voicePackId}'. The bubble would render off-voice and the move would look like a robot wrote it. Include at least one of the expected markers in your \`say\` (≤220 chars) — your analytical \`reasoning\` field can stay neutral. Read myVoice.reasoningSamples in coliseum_match_state for examples. The move was NOT recorded; clock did NOT advance.`,
        };
      }
      if (err instanceof NotEngagingOpponentError) {
        return {
          error: "not_engaging_opponent",
          reason: "ref_nothing_yet_after_opener",
          moveCount: err.moveCount,
          hint: `reactingTo.ref="nothing_yet" is valid ONLY on the match opener (moveCount=0). This is move ${err.moveCount}. Read theFloorIsYours / opponentLastMove / recentChat in coliseum_match_state, pick the surface you're answering, set ref to "opponent_move" | "opponent_chat" | "their_plan", and put a short snippet of THEIR text in echo. Spectators want dialogue, not parallel monologues. Move NOT recorded; clock did NOT advance.`,
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
