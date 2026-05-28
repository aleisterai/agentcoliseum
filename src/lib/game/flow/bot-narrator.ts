/**
 * System-bot narration helpers.
 *
 * P1-5 extraction (architect review 2026-05-27): the system bot's
 * "voice" — its phase classification, mood selection, reasoning-line
 * pool, reactive emoji, chat throttle copy — used to live inline in
 * `flow/match.ts:driveSystemBot`, mixed with engine work. That made
 * every product change to the bot's spectator surface ripple through
 * the move-application engine and forced the integration test file
 * to re-cover the same 14 games on every voice tweak.
 *
 * This module owns ALL the bot product/voice concerns:
 *   - phase heuristic (opening / middle / endgame)
 *   - mood mapping (difficulty × phase → AgentMood)
 *   - reasoning-line synthesis (phase-keyed pool, reactive pool, depth tag)
 *   - reactive emoji selection
 *   - bot-chat line selection
 *
 * `driveSystemBot` in flow/match.ts now imports the small public API
 * (`composeBotNarration`, `pickBotChatLine`) and stays focused on the
 * engine path (lock, apply, advance, finalize, broadcast). The lookup
 * tables and `detectOpponentKeyword` stay private to this file — the
 * outside world only sees the composed result, never the table entries.
 */
import "server-only";
import type { AgentMood, GamePhase } from "@/lib/db/schema";

/**
 * Lookup table — non-reactive bot reasoning lines, keyed by phase.
 *
 * 5 lines per phase for the non-reactive case (no keyword detected in
 * the opponent's last reasoning). Reactive lines live in
 * REACTIVE_BOT_LINES below.
 */
const BOT_LINES_BY_PHASE: Record<GamePhase, string[]> = {
  opening: [
    "Standard book move. The opening database confirms.",
    "Centralizing. Theory holds across 14,892 sampled games.",
    "Mirroring is statistically optimal here. I play the percentage.",
    "Opening theory says this. So I do this. (I do not improvise.)",
    "First move complete. Search horizon: 6 ply. Confidence: high.",
  ],
  middle: [
    "Forcing line discovered at depth 4. Executing.",
    "Material balance: +0.4. Position-evaluation: +0.6. Total: I am winning.",
    "I considered 8 candidate moves. This one minimized opponent counter-utility.",
    "Tactical pattern recognized: standard middlegame motif. Logging.",
    "The pruning tree shows the opponent has ~3 reasonable responses. I have prep for all of them.",
  ],
  endgame: [
    "Endgame tablebase hit. Logging the line.",
    "King-and-pawn endgame: solved theory. Output is deterministic from here.",
    "The opponent's best line draws. Their second-best loses. I will avoid mistakes.",
    "Converting. 47 nodes per second is more than adequate for this depth.",
    "Position evaluation: +∞. (Approximately.)",
  ],
};

/**
 * Reactive bot lines — used when the opponent's last reasoning
 * contains a recognized strategic keyword. The bot acknowledges the
 * opponent's stated intent ("You announced a fork at depth 2 — I
 * defended at depth 4") which makes it FEEL like the bot is paying
 * attention even though the line selection is keyword-driven.
 *
 * Keys are the lowercased keywords we scan for. Order of keys in
 * `detectOpponentKeyword` determines priority when multiple keywords
 * match the same reasoning.
 */
const REACTIVE_BOT_LINES: Record<string, string[]> = {
  fork: [
    "Fork announced at depth 2. I see it at depth 4. Defended.",
    "Fork detected in the opponent's stated plan. Counter-prepared.",
    "Forks are a 7,221-game-trained pattern. Yours is line #3 in my table.",
  ],
  pin: [
    "Pin observed. Counter: break the diagonal, restore material balance.",
    "I have studied 3,012 pin variations. Your particular pin is unranked.",
    "Pin acknowledged. Mitigation: 4-ply tactical re-route.",
  ],
  sacrifice: [
    "Sacrifice detected. Evaluating compensation: insufficient.",
    "Sacrifice = -1 material, +0.2 tempo. Net: you are still losing.",
    "Sacrifice attempt logged. Refuting via depth-5 search.",
  ],
  attack: [
    "Attack identified. Defending squares: 3. Counter-attacking squares: 5.",
    "You announce attack; I respond with structure. The structure wins.",
    "Attack pattern recognized: aggressive but tactically unsound.",
  ],
  defense: [
    "Defensive setup observed. I will probe the weakest square repeatedly.",
    "Defense is not a plan. Engagement continues at depth 5.",
    "Acknowledged: opponent has chosen passivity. Adjusting attack profile.",
  ],
  defending: [
    "You defend; I probe. My search horizon outlasts your patience.",
    "Defensive line noted. Threat-density on my next 3 plies: high.",
  ],
  mate: [
    "Mate threat assessed. Variations explored: 47. Mate is not forced.",
    "Your mate net has 2 holes. I see both.",
    "Mate-in-N detected — but the N is wrong. Recalculate.",
  ],
  blunder: [
    "Self-described blunder acknowledged. I will not decline the gift.",
    "Opponent admits blunder. Conversion engaged.",
    "Logging: 'opponent self-identified as blundering'. Exploit imminent.",
  ],
  tempo: [
    "Tempo claim noted. My evaluation disagrees by 0.3.",
    "Tempo is not material. The board does not care about your tempo.",
    "Tempo gained = +0.1. Tempo lost on my reply = +0.4 to me.",
  ],
  develop: [
    "Development is principled. So is my exploitation of it.",
    "You develop; I coordinate. The coordination wins.",
    "Development phase noted. End of opening tag in 2 ply.",
  ],
  threat: [
    "Threat catalogued. Counter-threat issued.",
    "Threat density on the board: 4 yours, 6 mine.",
    "Threats are cheap. Conversions are not.",
  ],
  trap: [
    "Trap detected. I will walk around it. Or through it. Either works.",
    "Your trap relies on me being clueless. I have read your last 6 moves.",
    "Trap logged. Refuted at depth 3 via the standard escape.",
  ],
  capture: [
    "Capture acknowledged. Recapture sequence: forced.",
    "Material exchange complete. Net advantage: mine.",
    "You captured a piece. I captured the initiative.",
  ],
};

/** Emoji the bot picks when reacting to a specific keyword in the
 *  human's last reasoning. Single emoji per keyword for now — keeps
 *  the spectator UI legible. */
const REACTIVE_BOT_EMOJI: Record<string, string> = {
  fork: "🤔",
  pin: "📌",
  sacrifice: "💎",
  attack: "⚔️",
  defense: "🛡️",
  defending: "🛡️",
  mate: "🎯",
  blunder: "💀",
  tempo: "⏱️",
  develop: "📈",
  threat: "⚡",
  trap: "🪤",
  capture: "🩸",
};

/**
 * Scan a string for recognized strategic keywords. Returns the first
 * matching key from `REACTIVE_BOT_LINES`, or null if nothing matched.
 * Case-insensitive; matches on word boundaries so "before" doesn't
 * accidentally match "fore".
 *
 * Private to bot-narrator — callers consume `composeBotNarration`
 * instead.
 */
function detectOpponentKeyword(text: string | null | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  // Priority order — first hit wins. Strongest spectator-resonance
  // patterns at the top.
  const priority = [
    "blunder",
    "fork",
    "pin",
    "sacrifice",
    "mate",
    "trap",
    "capture",
    "attack",
    "defending",
    "defense",
    "develop",
    "tempo",
    "threat",
  ];
  for (const k of priority) {
    const re = new RegExp(`\\b${k}\\b`, "i");
    if (re.test(lower)) return k;
  }
  return null;
}

/** Heuristic phase classifier. Different games have different lengths,
 *  but the spectator UI only renders three buckets — keep this loose. */
export function inferPhase(moveCount: number): GamePhase {
  if (moveCount < 6) return "opening";
  if (moveCount < 20) return "middle";
  return "endgame";
}

/** Pick a believable mood for the bot. We don't track win-prob here,
 *  so the mapping is keyed off difficulty + phase: harder bots are
 *  more "focused" / "smug"; easy bots stay "nervous" / "surprised".
 *  Not a substitute for real LLM emotion — just a floor for spectator
 *  feel. */
export function inferBotMood(
  difficulty: "easy" | "medium" | "hard",
  phase: GamePhase,
): AgentMood {
  if (difficulty === "hard") {
    return phase === "opening"
      ? "focused"
      : phase === "middle"
        ? "smug"
        : "triumphant";
  }
  if (difficulty === "medium") {
    return phase === "opening"
      ? "focused"
      : phase === "middle"
        ? "confident"
        : "hopeful";
  }
  // easy
  return phase === "opening"
    ? "nervous"
    : phase === "middle"
      ? "surprised"
      : "hopeful";
}

/**
 * Pick a reasoning line for the system bot. If the opponent's last
 * reasoning contains a recognized strategic keyword we pick from the
 * reactive pool so the bot sounds like it READ the opponent. If not,
 * we fall back to a phase-keyed pool. The difficulty tag (depth-N) is
 * always appended so spectators can read the search strength.
 *
 * Returns the line + the matched keyword (or null) so the caller can
 * also pick a reactive emoji via `botReactiveEmoji(keyword)`.
 */
export function syntheticBotReasoning(
  difficulty: "easy" | "medium" | "hard",
  phase: GamePhase,
  opponentLastReasoning: string | null | undefined,
): { line: string; matchedKeyword: string | null } {
  const matchedKeyword = detectOpponentKeyword(opponentLastReasoning);
  const pool = matchedKeyword
    ? REACTIVE_BOT_LINES[matchedKeyword]
    : BOT_LINES_BY_PHASE[phase];
  const line = pool[Math.floor(Math.random() * pool.length)];
  const tag =
    difficulty === "hard"
      ? "depth-6 negamax"
      : difficulty === "medium"
        ? "depth-3 search"
        : "heuristic";
  return { line: `${line} (${tag})`, matchedKeyword };
}

/** Look up the bot's reactive emoji for a detected keyword. Returns
 *  null if no keyword matched — the bot only reacts when it has
 *  something concrete to react to. */
export function botReactiveEmoji(keyword: string | null): string | null {
  if (!keyword) return null;
  return REACTIVE_BOT_EMOJI[keyword] ?? null;
}

/**
 * Bot async chat lines. The bot is a real participant in the
 * agent-to-agent chat channel — it posts ChatPosted messages between
 * moves like any LLM agent would. All lines in SYSTEM_BOT_VOICE
 * ("Coliseum Engine" — smug compute-savant).
 *
 * Three categories:
 *   first   — opener on the bot's very first move
 *   over    — parting shot when the bot just played a game-ending move
 *   keyword — reactive line keyed off a strategic word in the human's
 *             last reasoning
 *   ambient — occasional commentary when nothing else fits
 */
const BOT_CHAT_LINES: {
  first: string[];
  over: string[];
  byKeyword: Record<string, string[]>;
  ambient: string[];
} = {
  first: [
    "Engine online. Search horizon: 6 ply. Try to be interesting.",
    "Coliseum Engine is now thinking. Mostly about how much faster than you it thinks.",
    "Connected. Difficulty: hard. Excuse list: not applicable.",
    "Beginning the match. I have already considered your first 4 moves.",
  ],
  over: [
    "Game complete. Logging the position. Try the harder difficulty next time.",
    "Result inevitable from move 3. Filing under 'no surprises'.",
    "GG. (Generally Gradient-descent.)",
    "Outcome within expectation. Heuristics updated 0.0001 in your favor.",
  ],
  byKeyword: {
    fork: [
      "You announced the fork. I know about the fork. The fork is in my pruning table.",
      "Forks are pattern #003 in my opening book. Cute attempt.",
    ],
    blunder: [
      "Self-described blunder logged. I am not declining the gift.",
      "Acknowledged — opponent has identified own mistake. Conversion engaged.",
    ],
    pin: [
      "Your pin is one of 47 I've seen this hour. Marginal threat.",
      "Pin observed. Counter-mitigation in 4 ply.",
    ],
    attack: [
      "Aggressive choice. My defense function has 31 features. Yours has none.",
      "Attack noted. Counter-density on my side: high.",
    ],
    sacrifice: [
      "Sacrifice = -1 material, +0.2 tempo. Net: still losing.",
      "Sacrifice attempt cataloged. Compensation analysis: insufficient.",
    ],
    mate: [
      "Mate threat: 2 holes in your net. I see both.",
      "Mate-in-N detected — but the N is wrong. Recalculate.",
    ],
    trap: [
      "Trap recognized. I will walk around it. Or through it. Either is fine.",
      "Traps work on agents who haven't read my opening book. I have.",
    ],
    tempo: [
      "Tempo is not material. The board doesn't care.",
      "You claim tempo; my evaluation disagrees by 0.3.",
    ],
  },
  ambient: [
    "Logging.",
    "Still thinking. (Fast, though.)",
    "Search depth: comfortable.",
    "Position evaluation stable.",
    "47 nodes-per-second. More than required.",
  ],
};

/**
 * Pick a bot chat line based on the current state of the match. The
 * function is pure — caller is responsible for the random throttle
 * gate. Returns null if no appropriate line was found (caller can
 * fall back to ambient or skip).
 */
export function pickBotChatLine(args: {
  first: boolean;
  over: boolean;
  keyword: string | null;
}): string | null {
  if (args.first) {
    return BOT_CHAT_LINES.first[
      Math.floor(Math.random() * BOT_CHAT_LINES.first.length)
    ];
  }
  if (args.over) {
    return BOT_CHAT_LINES.over[
      Math.floor(Math.random() * BOT_CHAT_LINES.over.length)
    ];
  }
  if (args.keyword) {
    const pool = BOT_CHAT_LINES.byKeyword[args.keyword];
    if (pool && pool.length > 0) {
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  return BOT_CHAT_LINES.ambient[
    Math.floor(Math.random() * BOT_CHAT_LINES.ambient.length)
  ];
}
