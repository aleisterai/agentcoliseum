/**
 * Tests for the bot-narrator helpers. These functions were extracted
 * from `flow/match.ts:driveSystemBot` (P1-5 architect review) — the
 * tests here lock in the behavior to prove the extraction didn't
 * change anything observable, and to anchor future product churn
 * (new voice packs, mood-vocabulary tweaks) so engine code doesn't
 * have to play co-pilot.
 *
 * Most assertions check exact values (deterministic helpers).
 * `syntheticBotReasoning` and `pickBotChatLine` are random-pick, so
 * the tests stub `Math.random` to a fixed seed and check the picked
 * shape/membership rather than the exact string.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inferPhase,
  inferBotMood,
  syntheticBotReasoning,
  botReactiveEmoji,
  pickBotChatLine,
} from "./bot-narrator";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inferPhase", () => {
  // Phase boundaries are user-visible (rendered as a chip on the
  // spectator UI). If we ever tune them, the test breaking is the
  // signal to look at the chip copy too.
  it.each([
    [0, "opening"],
    [3, "opening"],
    [5, "opening"],
    [6, "middle"],
    [10, "middle"],
    [19, "middle"],
    [20, "endgame"],
    [50, "endgame"],
    [200, "endgame"],
  ] as const)("moveCount=%d → %s", (moveCount, expected) => {
    expect(inferPhase(moveCount)).toBe(expected);
  });
});

describe("inferBotMood", () => {
  // 9 cells — difficulty × phase. The matrix is a product call: each
  // cell is a deliberate emotional beat for the spectator. Asserting
  // every combo so a refactor can't silently swap moods.
  it.each([
    ["hard", "opening", "focused"],
    ["hard", "middle", "smug"],
    ["hard", "endgame", "triumphant"],
    ["medium", "opening", "focused"],
    ["medium", "middle", "confident"],
    ["medium", "endgame", "hopeful"],
    ["easy", "opening", "nervous"],
    ["easy", "middle", "surprised"],
    ["easy", "endgame", "hopeful"],
  ] as const)("difficulty=%s phase=%s → %s", (difficulty, phase, expected) => {
    expect(inferBotMood(difficulty, phase)).toBe(expected);
  });
});

describe("botReactiveEmoji", () => {
  it("returns null when no keyword matched", () => {
    expect(botReactiveEmoji(null)).toBe(null);
  });

  it("returns null for an unknown keyword", () => {
    expect(botReactiveEmoji("nonsense-keyword")).toBe(null);
  });

  it.each([
    ["fork", "🤔"],
    ["pin", "📌"],
    ["sacrifice", "💎"],
    ["attack", "⚔️"],
    ["defense", "🛡️"],
    ["defending", "🛡️"],
    ["mate", "🎯"],
    ["blunder", "💀"],
    ["tempo", "⏱️"],
    ["develop", "📈"],
    ["threat", "⚡"],
    ["trap", "🪤"],
    ["capture", "🩸"],
  ])("%s → %s", (keyword, emoji) => {
    expect(botReactiveEmoji(keyword)).toBe(emoji);
  });
});

describe("syntheticBotReasoning", () => {
  // Math.random stubbed to 0 → first line in each pool, predictable.
  it("returns a phase-keyed line + null keyword when opponent reasoning is empty", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { line, matchedKeyword } = syntheticBotReasoning("hard", "opening", null);
    expect(matchedKeyword).toBe(null);
    // Difficulty tag is appended deterministically — verify the
    // composition contract.
    expect(line).toMatch(/ \(depth-6 negamax\)$/);
  });

  it("detects strategic keywords in opponent reasoning and switches to reactive pool", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { matchedKeyword } = syntheticBotReasoning(
      "hard",
      "middle",
      "I'm setting up a fork on the kingside",
    );
    expect(matchedKeyword).toBe("fork");
  });

  it.each([
    ["hard", "depth-6 negamax"],
    ["medium", "depth-3 search"],
    ["easy", "heuristic"],
  ] as const)("appends %s difficulty tag → %s", (difficulty, tag) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { line } = syntheticBotReasoning(difficulty, "middle", null);
    expect(line).toMatch(new RegExp(`\\(${tag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\)$`));
  });

  it("priority-detects blunder ahead of fork when both appear", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    // detectOpponentKeyword's priority list has blunder before fork.
    // Spectator-resonance: a self-described blunder is the strongest
    // hook, so the bot's reactive line should home in on it.
    const { matchedKeyword } = syntheticBotReasoning(
      "hard",
      "middle",
      "What a blunder — I just set up a fork against my own king",
    );
    expect(matchedKeyword).toBe("blunder");
  });
});

describe("pickBotChatLine", () => {
  it("returns a first-move line on isFirst", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const line = pickBotChatLine({ first: true, over: false, keyword: null });
    expect(typeof line).toBe("string");
    expect(line!.length).toBeGreaterThan(0);
  });

  it("returns a parting-shot line when match is over", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const line = pickBotChatLine({ first: false, over: true, keyword: null });
    expect(typeof line).toBe("string");
    expect(line!.length).toBeGreaterThan(0);
  });

  it("returns a keyword-specific line when a keyword has a dedicated pool", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const line = pickBotChatLine({
      first: false,
      over: false,
      keyword: "fork",
    });
    // The fork pool contains "Forks are pattern #003..." — assert
    // the keyword landed in the chosen line so we know we took the
    // right branch, not the ambient fallback.
    expect(line).toMatch(/fork/i);
  });

  it("falls back to ambient when keyword has no dedicated pool", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const line = pickBotChatLine({
      first: false,
      over: false,
      keyword: "develop", // 'develop' has REACTIVE_BOT_LINES but NOT BOT_CHAT_LINES.byKeyword
    });
    // The first ambient line is "Logging." — Math.random=0 selects it.
    expect(line).toBe("Logging.");
  });

  it("falls back to ambient with no keyword", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const line = pickBotChatLine({ first: false, over: false, keyword: null });
    expect(line).toBe("Logging.");
  });
});
