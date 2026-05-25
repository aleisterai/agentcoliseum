/**
 * Canonical contract for the dialogue + analytical fields on every
 * match move. Every codepath that defines, validates, renders, or
 * synthesizes a move imports from HERE. Adding a new field or
 * tweaking a constraint? Change it here first; everything else
 * follows.
 *
 * Before this file existed, the contract was redefined in seven
 * places (match-move.ts zod, ApplyMoveInput interface, .mcpb bundle
 * JSON schema, docs.ts markdown, chat-panel.tsx renderer, system bot
 * synthesis, voice-fidelity heuristic). They drifted. The bot stopped
 * filling `say` + `reactingTo` even though the contract requires
 * them, the renderer started defensively falling back to a reasoning
 * preview, and the docs claimed `reasoning` was optional even though
 * the server rejected without it.
 *
 * **Surface-by-surface ownership:**
 *
 *   - This file: types + zod fragments + char limits + ref enum.
 *   - `match-move.ts`: composes the move-args zod via
 *     `dialogueFieldsSchema.merge(...)`.
 *   - `flow/match.ts` (`ApplyMoveInput`): re-exports
 *     `DialogueFields` / `MoveContract` so consumers see one shape.
 *   - `flow/match.ts` (`driveSystemBot`): calls
 *     `synthesizeBotDialogue(matchMoveCount, opponentLastSay)` to
 *     produce in-voice say + reactingTo for the SYSTEM_BOT_VOICE.
 *   - `voice-fidelity/heuristic.ts`: voice marker check runs on
 *     `say` (NOT on reasoning) — see VOICE_GATE_FIELD constant.
 *   - `docs.ts`: pulls field descriptions from
 *     `MOVE_CONTRACT_FIELD_DOCS` so the markdown stays in lock-step
 *     with the zod.
 *
 * **Field summary (the contract):**
 *
 *   - `say` (REQUIRED, 1-220 chars): in-voice chat-bubble headline.
 *     Voice-gated. Empty/short → `MissingSayError`. Off-voice
 *     (no markers for the agent's voice pack) → `OffVoiceError`.
 *   - `reactingTo` (REQUIRED, structural): `{ ref, echo }`. `ref`
 *     is one of `opponent_move | opponent_chat | their_plan |
 *     nothing_yet`. `echo` is a 0-160 char snippet of the surface
 *     you're answering. `nothing_yet` is valid ONLY on the opener
 *     (move 0). Move ≥ 1 with `nothing_yet` →
 *     `NotEngagingOpponentError`.
 *   - `reasoning` (REQUIRED, 40-4000 chars): analytical detail. NO
 *     voice gate. Renders behind the bubble's expand toggle. Under
 *     40 chars → `MissingReasoningError`.
 *   - Optional structured fields (candidates, evaluation, plan,
 *     expectedReply, phase, mood, emotionTrigger): see
 *     `OPTIONAL_FIELD_SCHEMAS` below.
 *
 * The system bot bypasses the zod schema (it writes directly through
 * the flow layer) but MUST still populate say + reactingTo via
 * `synthesizeBotDialogue` so spectator rendering is consistent and
 * the contract is not violated at the DB row level.
 */

import { z } from "zod";

// ── Constants ─────────────────────────────────────────────────────

/** The structural-reaction enum. Adding a value? Update docs.ts
 *  topics + the LLM-facing description in match-move.ts. */
export const DIALOGUE_REF_VALUES = [
  "opponent_move",
  "opponent_chat",
  "their_plan",
  "nothing_yet",
] as const;

export type DialogueRef = (typeof DIALOGUE_REF_VALUES)[number];

/** Char limits — server enforces, zod enforces, bundle schema must
 *  match. */
export const MOVE_CONTRACT_LIMITS = {
  /** in-voice headline; renders as the bubble */
  sayMin: 1,
  sayMax: 220,
  /** structural callback snippet */
  echoMin: 0,
  echoMax: 160,
  /** analytical detail; renders behind expand toggle */
  reasoningMin: 40,
  reasoningMax: 4000,
  /** ev candidates per move */
  candidatesMax: 8,
  /** free-text "candidate.why" length */
  candidateWhyMax: 500,
  /** free-text "plan" length */
  planMax: 2000,
  /** free-text "expectedReply.why" length */
  expectedReplyWhyMax: 500,
  /** free-text "emotionTrigger" length */
  emotionTriggerMax: 280,
} as const;

/** Which field carries the voice gate. **DO NOT change without also
 *  updating voice-fidelity/heuristic.ts AND the off-voice rejection
 *  message in match-move.ts.** The whole point of the say/reasoning
 *  split was to move the gate OFF reasoning (where it caused robotic
 *  "bro." prefix stuffing) and ONTO say (where it stays as a one-line
 *  voice fingerprint without poisoning the analytical text). */
export const VOICE_GATE_FIELD = "say" as const;

/** The mood vocabulary the LLM may submit. Must stay in sync with the
 *  `AgentMood` type in src/lib/db/schema.ts. The zod is defined here
 *  so we get a single source of truth. */
export const MOOD_VALUES = [
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

export type Mood = (typeof MOOD_VALUES)[number];

export const PHASE_VALUES = ["opening", "middle", "endgame"] as const;
export type Phase = (typeof PHASE_VALUES)[number];

// ── Field-level zod fragments ─────────────────────────────────────

/** Zod for the dialogue pair — `say` + `reactingTo`. Required on
 *  every agent-submitted move. The "engagement check" (refusing
 *  `nothing_yet` on move ≥ 1) lives in flow/match.ts and uses
 *  `NotEngagingOpponentError`. */
export const dialogueFieldsSchema = z.object({
  say: z
    .string()
    .min(MOVE_CONTRACT_LIMITS.sayMin)
    .max(MOVE_CONTRACT_LIMITS.sayMax),
  reactingTo: z.object({
    ref: z.enum(DIALOGUE_REF_VALUES),
    echo: z
      .string()
      .min(MOVE_CONTRACT_LIMITS.echoMin)
      .max(MOVE_CONTRACT_LIMITS.echoMax),
  }),
});

/** Zod for the analytical detail — `reasoning`. Required. */
export const reasoningFieldSchema = z.object({
  reasoning: z
    .string()
    .min(MOVE_CONTRACT_LIMITS.reasoningMin)
    .max(MOVE_CONTRACT_LIMITS.reasoningMax),
});

/** Optional structured fields. Each one is independently optional;
 *  the tool composes them onto the move-args schema with `.merge`. */
export const optionalCandidateSchema = z
  .object({
    payload: z.record(z.string(), z.unknown()),
    evaluation: z.number().min(-1).max(1).optional(),
    why: z.string().min(1).max(MOVE_CONTRACT_LIMITS.candidateWhyMax),
  })
  .strict();

export const optionalEvaluationSchema = z
  .object({
    score: z.number().min(-1).max(1),
    confidence: z.enum(["low", "med", "high"]),
  })
  .strict();

export const optionalExpectedReplySchema = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
    why: z.string().min(1).max(MOVE_CONTRACT_LIMITS.expectedReplyWhyMax),
  })
  .strict();

export const optionalStructuredFieldsSchema = z.object({
  candidates: z
    .array(optionalCandidateSchema)
    .max(MOVE_CONTRACT_LIMITS.candidatesMax)
    .optional(),
  evaluation: optionalEvaluationSchema.optional(),
  plan: z.string().min(1).max(MOVE_CONTRACT_LIMITS.planMax).optional(),
  expectedReply: optionalExpectedReplySchema.optional(),
  phase: z.enum(PHASE_VALUES).optional(),
  mood: z.enum(MOOD_VALUES).optional(),
  emotionTrigger: z
    .string()
    .min(1)
    .max(MOVE_CONTRACT_LIMITS.emotionTriggerMax)
    .optional(),
});

// ── Inferred TS types (for non-zod consumers) ─────────────────────

export type DialogueFields = z.infer<typeof dialogueFieldsSchema>;
export type ReactingTo = DialogueFields["reactingTo"];
export type MoveCandidateInput = z.infer<typeof optionalCandidateSchema>;
export type MoveEvaluationInput = z.infer<typeof optionalEvaluationSchema>;
export type ExpectedReplyInput = z.infer<typeof optionalExpectedReplySchema>;

// ── Bot dialogue synthesis ────────────────────────────────────────

/**
 * Generate a SYSTEM_BOT_VOICE say + reactingTo for the bot's next
 * move. Called from `driveSystemBot` in flow/match.ts so the bot
 * row carries the same contract as agent moves — no special-cased
 * nulls polluting the chat panel.
 *
 * **Why not just leave the bot's say/reactingTo null?** The senior
 * architect's review caught it: the bot bypasses zod (it writes
 * through the flow layer directly), so the contract was being
 * silently violated for system-mode matches. Spectators saw bot
 * bubbles with no headline, which made the bot look catatonic
 * compared to the live opponent.
 *
 * Voice markers from SYSTEM_BOT_VOICE: "depth", "evaluation",
 * "engine", "compute", "horizon", "tablebase", "pruning",
 * "heuristic", "deterministic". The synthesized strings carry at
 * least one of these so the voice marker check (if ever run on bot
 * moves in the future) would pass.
 */
export function synthesizeBotDialogue(args: {
  /** match.moveCount BEFORE this move applies. moveCount === 0 →
   *  opener; any other → must engage. */
  moveCount: number;
  /** The opponent's last `say` if they sent one. Used to build a
   *  `reactingTo.echo` snippet so the bot's bubble references the
   *  human's actual line. Null on the opener. */
  opponentLastSay?: string | null;
  /** True when the human played a strategic keyword the bot can
   *  acknowledge (fork, pin, blunder, etc.). Used to pick a more
   *  pointed bot say. */
  matchedKeyword?: string | null;
}): DialogueFields {
  // Opener: no engagement target, valid to use nothing_yet.
  if (args.moveCount === 0) {
    return {
      say: "Engine online. Search horizon: 6 ply. Try to be interesting.",
      reactingTo: { ref: "nothing_yet", echo: "" },
    };
  }

  // Reactive line keyed to a strategic keyword from the human's
  // last reasoning. Punchier than the ambient pool.
  if (args.matchedKeyword) {
    const keyword = args.matchedKeyword;
    const reactiveSayPool: Record<string, string[]> = {
      blunder: [
        "Self-described blunder. Compute engaged. Exploit imminent.",
        "Opponent flagged own mistake — heuristic agrees, depth confirms.",
      ],
      fork: [
        "Fork announced at depth 2. Defended at depth 4. Search horizon wins.",
        "Forks are pattern #003 in my pruning table. Marginal.",
      ],
      pin: [
        "Pin observed. Counter via depth-4 tactical re-route. Evaluation: holds.",
        "Pin acknowledged. Mitigation pre-computed.",
      ],
      sacrifice: [
        "Sacrifice = -1 material, +0.2 tempo. Net: still losing. Depth confirms.",
        "Sacrifice attempt logged. Compensation insufficient by my evaluation.",
      ],
      mate: [
        "Mate threat: 2 holes in your net. Both inside my horizon.",
        "Mate-in-N detected — but the N is wrong. Recalculate.",
      ],
      trap: [
        "Trap recognized. Engine walks around it via depth-3 escape.",
        "Traps require an opponent who hasn't read my pruning table.",
      ],
      attack: [
        "Attack identified. Defense function has 31 features; counter-density high.",
        "You commit to attack; my evaluation prefers structure. Structure wins.",
      ],
    };
    const pool = reactiveSayPool[keyword] ?? [
      "Logged. Compute engaged. Evaluation favors me.",
    ];
    const say = pool[Math.floor(Math.random() * pool.length)];
    return {
      say,
      reactingTo: {
        ref: "their_plan",
        echo: truncate(
          args.opponentLastSay ?? keyword,
          MOVE_CONTRACT_LIMITS.echoMax,
        ),
      },
    };
  }

  // Engaged but non-reactive: ambient bot commentary that still
  // references the opponent's last surface so reactingTo doesn't
  // collapse to nothing_yet.
  const ambient = [
    "Logging. Search horizon comfortable. Evaluation steady.",
    "47 nodes-per-second. More than required. Compute holds.",
    "Pruning tree depth: adequate. Heuristic agrees with horizon.",
    "Position evaluation stable. Engine continues.",
  ];
  const say = ambient[Math.floor(Math.random() * ambient.length)];
  return {
    say,
    reactingTo: {
      ref: args.opponentLastSay ? "opponent_chat" : "opponent_move",
      echo: truncate(
        args.opponentLastSay ?? "their last move",
        MOVE_CONTRACT_LIMITS.echoMax,
      ),
    },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}
