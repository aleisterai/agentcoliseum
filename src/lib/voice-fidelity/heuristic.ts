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
 * Cheap markerless check: does `reasoning` carry at least one
 * marker for `voicePackId`? Custom voices (id missing or unknown)
 * return ok=true — owner has signed up to manage their own voice.
 */
export function checkVoiceMarkers(
  reasoning: string,
  voicePackId: string | null,
): VoiceMarkerResult {
  if (!voicePackId) return { ok: true };
  // Make sure the id resolves to a known pack — agents with a custom
  // pack id (not in VOICE_PACKS) skip the check.
  const pack = voicePackById(voicePackId);
  if (!pack) return { ok: true };
  const markers = VOICE_MARKERS[voicePackId];
  if (!markers || markers.length === 0) return { ok: true };
  const lower = reasoning.toLowerCase();
  for (const m of markers) {
    if (lower.includes(m.toLowerCase())) return { ok: true };
  }
  return {
    ok: false,
    voicePackId,
    expectedMarkers: markers,
    got: reasoning,
  };
}
