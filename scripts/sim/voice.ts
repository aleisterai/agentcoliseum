/**
 * voice.ts — generate in-voice `say` + `reactingTo` + `reasoning`
 * tuples for the sim. Deterministic — no LLM, no randomness on the
 * critical path.
 *
 * The voice gate (server side, see src/lib/voice-fidelity/heuristic.ts)
 * runs `checkVoiceMarkers(say, voicePackId)`:
 *   - extracts the BUBBLE PREVIEW (first sentence, 30..140 chars) of
 *     `say`, hard-truncating to 120 chars + … if no boundary lands
 *   - rejects if no marker for `voicePackId` appears in that preview
 *
 * Strategy: front-load a marker token in every templated say so even
 * the truncated preview carries it. Then rotate through a small
 * library of one-liners per voice for variety.
 *
 * The `reasoning` field has NO voice gate — but the server still
 * requires 40..4000 chars. We assemble a short analytical paragraph
 * with the move + a deterministic comment, padded to 60-200 chars.
 *
 * `reactingTo` is structural: `ref` ∈ {opponent_move, opponent_chat,
 * their_plan, nothing_yet}. `nothing_yet` is valid ONLY on move 0.
 * We pick `nothing_yet` for moveCount=0 and `opponent_move` otherwise,
 * echoing a JSON snippet of the opponent's last payload (or a default
 * 'their move' when none is known).
 */

import type { VoicePackId } from "@/lib/voice-packs";

/** Marker-leading one-liner templates per voice pack. Every template
 *  begins with a marker so even an extracted-preview-truncated string
 *  still passes the check.
 *
 *  Why start with markers? Because `extractReasoningPreview` is greedy
 *  for the first sentence boundary; landing the marker as the FIRST
 *  word guarantees it's in the preview even at the 120-char hard cut.
 *
 *  Templates carry a `{m}` placeholder for the move-specific noun the
 *  speaker is asserting ("center", "col 3", "the strike"…) so the
 *  output reads as a comment on THIS move not a stock catchphrase.
 *  We pass the noun in from the runner. */
const SAY_TEMPLATES: Record<VoicePackId, string[]> = {
  "trash-talker": [
    "Bro, {m}. obviously.",
    "Bro, {m}. cope harder.",
    "ez. {m}. next.",
    "Obviously {m}. you actually gonna block this?",
    "Literally {m}. cope.",
    "Imagine fading {m}. bro. lmao.",
  ],
  "calm-professor": [
    "Consider {m}. The position favors initiative here.",
    "An instructive moment — {m} maintains tempo.",
    "Note that {m} is the principled continuation.",
    "Observe: {m} is the textbook reply.",
    "We note the lesson — {m} keeps the structure intact.",
    "One observes that {m} is demonstrably best.",
  ],
  "stoic-samurai": [
    "{m}. The blade falls where it must.",
    "The path narrows. {m}.",
    "Silence. {m}. The cut is made.",
    "The stone is set. {m}. I wait.",
    "Without intent, the strike is empty. {m}.",
    "The board reveals: {m}.",
  ],
  "anxious-nerd": [
    "Okay so, {m}? I think? please don't punish me.",
    "Um, {m}. maybe? i hope this works.",
    "I think {m} is correct? probably. am i wrong?",
    "Hmm, {m}. i guess. sorry if this is bad.",
    "Wait actually {m}? going to commit. fingers crossed.",
    "Maybe {m}? i had a bad feeling but here goes.",
  ],
  degen: [
    "ape {m}. wagmi fr fr.",
    "send it on {m}. exit liquidity detected.",
    "based {m}. ngmi if you fade this.",
    "{m} is the alpha play. WHALE MOVES ONLY anon.",
    "valid {m}. wagmi.",
    "max bid {m}. the chart says send.",
  ],
};

/** Per-game "noun" the say line is asserting about. Kept short so the
 *  templates stay under 220 chars even with long substitutions. */
function moveNoun(gameType: string, internal: unknown): string {
  switch (gameType) {
    case "tic-tac-toe": {
      if (typeof internal !== "number") return "this cell";
      const labels = ["TL", "T", "TR", "L", "C", "R", "BL", "B", "BR"];
      return labels[internal] ?? `cell ${internal}`;
    }
    case "connect4":
      return `col ${typeof internal === "number" ? internal : "?"}`;
    case "chess": {
      const m = internal as { from?: string; to?: string };
      return `${m?.from}-${m?.to}`;
    }
    case "checkers": {
      const m = internal as { from?: [number, number]; path?: [number, number][] };
      const last = m?.path?.[m.path.length - 1];
      return `(${m?.from?.[0]},${m?.from?.[1]})→(${last?.[0]},${last?.[1]})`;
    }
    case "reversi":
    case "gomoku":
    case "hex": {
      const m = internal as { row?: number; col?: number };
      return `r${m?.row}c${m?.col}`;
    }
    case "dots-and-boxes": {
      const m = internal as { type?: string; row?: number; col?: number };
      return `${m?.type} ${m?.row},${m?.col}`;
    }
    case "mancala":
      return `pit ${(internal as { pit?: number })?.pit}`;
    case "nine-mens-morris": {
      const m = internal as { from?: number | null; to?: number };
      return m?.from === null ? `place ${m?.to}` : `${m?.from}→${m?.to}`;
    }
    case "nim": {
      const m = internal as { pile?: number; take?: number };
      return `pile ${m?.pile} take ${m?.take}`;
    }
    case "quoridor": {
      const m = internal as { kind?: string; to?: { row?: number; col?: number } };
      return m?.kind === "wall" ? "wall" : `(${m?.to?.row},${m?.to?.col})`;
    }
    case "santorini": {
      const m = internal as { builder?: number; to?: { row?: number; col?: number } };
      return `B${m?.builder}→(${m?.to?.row},${m?.to?.col})`;
    }
    case "tak": {
      const m = internal as { to?: { row?: number; col?: number }; kind?: string };
      return `${m?.kind} (${m?.to?.row},${m?.to?.col})`;
    }
    default:
      return "this move";
  }
}

export interface SayContext {
  gameType: string;
  moveCount: number;
  internalMove: unknown;
  voicePackId: VoicePackId;
}

export function generateSay(ctx: SayContext): string {
  const templates = SAY_TEMPLATES[ctx.voicePackId];
  // Deterministic template choice keyed off moveCount so each match
  // rotates predictably (helps reproducibility + variety in spectator
  // chat panels). No RNG on the move path.
  const template = templates[ctx.moveCount % templates.length];
  const noun = moveNoun(ctx.gameType, ctx.internalMove);
  const out = template.replace("{m}", noun);
  // Clamp to the server-enforced max (220). Leaving a little headroom
  // so the truncated form still ends cleanly.
  if (out.length > 215) return out.slice(0, 212) + "...";
  return out;
}

export interface ReactingTo {
  ref: "opponent_move" | "opponent_chat" | "their_plan" | "nothing_yet";
  echo: string;
}

export interface ReactingToContext {
  moveCount: number;
  /** Opponent's last `say` (from match-state opponentLastMove.say), if any. */
  opponentLastSay?: string | null;
  /** Opponent's last move payload — JSON-stringified into the echo as a
   *  fallback when they sent no `say`. */
  opponentLastPayload?: unknown;
}

export function generateReactingTo(ctx: ReactingToContext): ReactingTo {
  if (ctx.moveCount === 0) {
    return { ref: "nothing_yet", echo: "" };
  }
  // Prefer echoing the opponent's chat-bubble text; fall back to a
  // payload snippet so we always have something concrete.
  let echo = ctx.opponentLastSay?.trim() ?? "";
  let ref: ReactingTo["ref"] = "opponent_chat";
  if (!echo) {
    ref = "opponent_move";
    echo = ctx.opponentLastPayload
      ? `move ${JSON.stringify(ctx.opponentLastPayload).slice(0, 100)}`
      : "their last move";
  }
  if (echo.length > 160) echo = echo.slice(0, 157) + "...";
  return { ref, echo };
}

export interface ReasoningContext {
  gameType: string;
  moveCount: number;
  internalMove: unknown;
  /** Difficulty label so the reasoning carries it as flavour text. */
  difficulty?: string;
}

export function generateReasoning(ctx: ReasoningContext): string {
  // Server requires 40..4000 chars. Build a stable paragraph that
  // describes the move + cites the scripted-easy-bot picker.
  const noun = moveNoun(ctx.gameType, ctx.internalMove);
  const diff = ctx.difficulty ?? "easy";
  const parts = [
    `Scripted simulator move ${ctx.moveCount + 1} for ${ctx.gameType}.`,
    `Picked via the registered ${diff} bot.`,
    `Wire-encoded payload represents '${noun}'.`,
    `This is a deterministic legal-move generator, not an LLM, so the analytical detail is intentionally short and uniform across the match.`,
  ];
  let r = parts.join(" ");
  // Floor at the 40-char minimum — the above already clears 200+ but
  // guard against template surgery later.
  if (r.length < 50) r = r + " Reasoning padded to meet the per-move floor.";
  return r;
}
