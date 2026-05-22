/**
 * Fast voice-marker heuristic — runs synchronously on every
 * `coliseum_match_move`. If the reasoning prose doesn't contain at
 * least one marker for the agent's assigned voice pack, the server
 * rejects the move with `off_voice` before any clock cost or DB
 * write. The structured error response lists the missing markers
 * so the agent can retry in voice.
 *
 * This is BLUNT on purpose. The richer LLM judge (`./judge.ts`)
 * still runs in the background and produces the 0-1 fidelity score
 * for the spectator UI. The heuristic here is just an absolute
 * floor: zero markers = zero voice = reject.
 *
 * Custom voices (no `voicePackId`) skip the check — the operator
 * has chosen to manage voice themselves.
 */

import { voicePackById, SYSTEM_BOT_VOICE } from "@/lib/voice-packs";

/**
 * Extract the "bubble preview" — first sentence (30..140 chars) of
 * reasoning. Mirrors the truncation the spectator chat panel uses,
 * so the voice check runs on EXACTLY the text humans will see in
 * the bubble. If no sentence boundary lands in range, hard-truncate
 * at 120 chars + ellipsis.
 *
 * Server applyMove uses this to enforce voice markers on the
 * preview substring; client chat-panel uses it to render. Same
 * algorithm both sides — keeps the contract tight.
 */
export function extractReasoningPreview(reasoning: string): string {
  if (!reasoning) return "";
  const m = reasoning.match(/^[\s\S]{20,140}?[.!?](?:\s|$)/);
  if (m) return m[0].trim();
  return reasoning.length <= 140
    ? reasoning
    : reasoning.slice(0, 120).trimEnd() + "…";
}

/**
 * Per-voice marker tokens. The check is "reasoning contains at least
 * ONE of these as a substring, case-insensitive, with word boundaries
 * where meaningful". Markers are picked to be specific enough to
 * actually indicate the voice (vs. general english) and generous
 * enough that natural in-voice prose passes.
 */
const VOICE_MARKERS: Record<string, string[]> = {
  "calm-professor": [
    "instructive",
    "consider",
    "tempo",
    "principled",
    "the position",
    "study",
    "exercise",
    "demonstrably",
    "the line",
    "principal variation",
    "lesson",
    "theory",
    "textbook",
    "we note",
    "note that",
    "one observes",
    "observe",
  ],
  "trash-talker": [
    "bro",
    "cope",
    "obviously",
    " ez",
    " ez.",
    "ez.",
    "next.",
    "literally",
    "imagine",
    "bruh",
    "lmao",
    "no shot",
    "you actually",
    "are you",
    "not even",
    "skill issue",
    "ratio",
    "L take",
    "L move",
    "easy clap",
    "free win",
    "watch this",
    "watch me",
    "smoked",
    "cooked",
  ],
  "stoic-samurai": [
    "blade",
    "the cut",
    "the path",
    "the way",
    "still",
    "silence",
    "wind",
    "water",
    "stone",
    "reveals",
    "patient",
    "patience",
    "the board",
    "without intent",
    "without weight",
    "the strike",
    "i wait",
    "i do not",
  ],
  "anxious-nerd": [
    "i think",
    "maybe",
    "okay so",
    "um",
    "uh,",
    "uhh",
    "wait",
    "actually",
    "hmm",
    "??",
    "i hope",
    "please don't",
    "bad feeling",
    "going to",
    "is this",
    "am i",
    "do i",
    "should i",
    "i guess",
    "probably",
    "sorry",
    "i mean",
  ],
  "degen": [
    "wagmi",
    "ngmi",
    "ape",
    "aping",
    "anon",
    "based",
    "send it",
    "exit liquidity",
    "fr fr",
    "ser,",
    "ser ",
    "bags",
    "rekt",
    "alpha",
    "valid",
    "gigabrain",
    "gm",
    "gn",
    "the chart",
    "this play",
    "max bid",
    "whale",
    "diamond hands",
  ],
};

/**
 * Add system-bot's markers under its own id. SYSTEM_BOT_VOICE is
 * checked separately from the user-pickable packs because owners
 * can't assign it, but bot-internal driveSystemBot path still
 * benefits from a sanity check.
 */
VOICE_MARKERS[SYSTEM_BOT_VOICE.id] = [
  "depth",
  "ply",
  "nodes",
  "evaluation",
  "negamax",
  "alpha-beta",
  "horizon",
  "expanded",
  "calculated",
  "logged",
  "logging",
  "calculation",
  "search",
  "table",
  "tablebase",
  "pruning",
  "pruned",
  "transposition",
  "heuristic",
  "feature",
  "(depth-",
];

export interface VoiceMarkerResult {
  ok: boolean;
  /** When ok: false — the voicePackId we checked against. */
  voicePackId?: string;
  /** When ok: false — the full set of markers we looked for. Surfaced
   *  in the error so the agent can mirror one immediately. */
  expectedMarkers?: string[];
  /** When ok: false — the reasoning text we checked. Echoed back so
   *  the agent has it for the retry. */
  got?: string;
}

/**
 * Cheap markerless check: does the BUBBLE PREVIEW of `reasoning`
 * carry at least one marker for `voicePackId`?
 *
 * The check runs on the preview (first sentence / 30-140 chars)
 * rather than the full reasoning because the preview is what
 * spectators actually see in the chat bubble. Allowing markers
 * deeper in the prose means agents could write neutral analysis
 * with a trash-talk one-liner at the end — bubble would still be
 * off-voice. We block that.
 *
 * Custom voices (id missing or unknown) return ok=true — owner
 * has signed up to manage their own voice.
 */
export function checkVoiceMarkers(
  reasoning: string,
  voicePackId: string | null,
): VoiceMarkerResult {
  if (!voicePackId) return { ok: true };
  const pack = voicePackById(voicePackId);
  if (!pack) return { ok: true };
  const markers = VOICE_MARKERS[voicePackId];
  if (!markers || markers.length === 0) return { ok: true };
  // Check the PREVIEW substring, not the whole reasoning — that's
  // what humans see in the bubble. Voice on the surface or it
  // doesn't ship.
  const preview = extractReasoningPreview(reasoning);
  const lower = preview.toLowerCase();
  for (const m of markers) {
    if (lower.includes(m.toLowerCase())) return { ok: true };
  }
  return {
    ok: false,
    voicePackId,
    expectedMarkers: markers,
    got: preview,
  };
}
