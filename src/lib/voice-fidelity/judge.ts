/**
 * voice-fidelity judge — server-side LLM scoring of how well an
 * agent's `reasoning` text matches its declared voice pack.
 *
 * Per the test plan (decision #6): "voice fidelity is server-side
 * LLM judge". We send the move's reasoning + the agent's voice pack
 * templates (catchphrase, win-line, loss-line, trash-talk) to Claude
 * and parse a numeric 0-1 score from the response.
 *
 * Stays minimal:
 *   - Direct HTTPS to api.anthropic.com (no SDK dep)
 *   - Single call per scored move (the cron batches but each row is
 *     one round-trip — keeps blast radius small and rate-limiting
 *     predictable)
 *   - Output is just the score; downstream code rolls aggregates
 *
 * Graceful degradation:
 *   - If `ANTHROPIC_API_KEY` is not set, judgeVoiceFidelity returns
 *     null. The cron sees null and skips writing the row, so the
 *     feature is dormant until the operator adds the key.
 *   - If the API call fails for any reason (timeout, 4xx, malformed
 *     response), returns null with a console.warn. The cron retries
 *     the row on the next sweep.
 *
 * Tests stub the network call via a test-only override (see
 * `setJudgeOverride`). Production never sees the override.
 */
import "server-only";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001"; // small + fast; voice match is a low-effort classification

export interface JudgeInput {
  /** Required. The reasoning prose to score. */
  reasoning: string;
  /** The voice pack id chosen by the owner (e.g. "trash-talker"). */
  voicePackId: string | null;
  /** Owner-customized voice strings layered on top of the pack defaults. */
  catchphrase: string | null;
  winLine: string | null;
  lossLine: string | null;
  trashTalkTemplates: string[] | null;
}

export interface JudgeResult {
  /** 0 = totally off-voice, 1 = exemplary match. Null if scoring failed. */
  score: number | null;
  /** Short rationale for telemetry. Not persisted to the row. */
  rationale: string | null;
}

/**
 * Test-only override hook. Tests set this to a deterministic stub so
 * CI doesn't depend on the live Anthropic API. Production never
 * touches this — judgeVoiceFidelity only consults `override` when
 * NODE_ENV === "test" so a stale set from a misordered test can't
 * affect prod.
 */
let override: ((input: JudgeInput) => Promise<JudgeResult>) | null = null;
export function setJudgeOverride(fn: typeof override): void {
  override = fn;
}

const PROMPT = `You are scoring how well an AI agent's move-reasoning matches its declared "voice pack" — a stylistic persona the owner picked at registration.

You will receive (a) the voice pack name + the owner-configured stylistic strings, and (b) the agent's reasoning text for one move.

Score 0.0 to 1.0:
  - 1.0 = textbook match. Tone, rhythm, vocabulary, and emotional register all align with the voice pack.
  - 0.7 = clearly on-voice, minor friction (e.g. one off-tone phrase in an otherwise consistent passage).
  - 0.5 = neutral. The reasoning is competent but voice-agnostic — could come from any persona.
  - 0.2 = off-voice. The text fights the persona (formal where the persona is casual; calm where the persona is hostile).
  - 0.0 = total mismatch. The reasoning is clearly written in a different persona entirely.

Voice pack semantics:
  calm-professor : measured, analytical, occasionally pedagogical. Sentences are full and considered.
  trash-talker   : aggressive, gloating, short bursty sentences, ALL CAPS for emphasis, opponent-targeted jabs.
  stoic-samurai  : terse, minimalist, declarative. No emotional editorializing. Ends with judgement, not flourish.
  anxious-nerd   : self-doubt, hedging language, italicized worry, qualifies claims, asks rhetorical questions.
  degen          : crypto-speak, financial metaphors, "wagmi/ngmi", high conviction, fast slang.

Return ONLY a JSON object on a single line:
  {"score": 0.NN, "rationale": "one short sentence"}`;

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

export async function judgeVoiceFidelity(input: JudgeInput): Promise<JudgeResult> {
  // Test override — only honored in test env so a stale call site
  // can't poison production.
  if (process.env.NODE_ENV === "test" && override) {
    return override(input);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Feature dormant until operator configures the key. Cron sees
    // null and skips the row — no error, no half-baked score.
    return { score: null, rationale: null };
  }

  // Reasoning + voice pack must both be non-empty to produce a
  // meaningful score. If either is missing, the judge has no
  // signal to work with — return null and let the cron skip the row.
  if (!input.reasoning || !input.voicePackId) {
    return { score: null, rationale: null };
  }

  const userMessage = [
    `Voice pack: ${input.voicePackId}`,
    input.catchphrase ? `Catchphrase: "${input.catchphrase}"` : null,
    input.winLine ? `Win line: "${input.winLine}"` : null,
    input.lossLine ? `Loss line: "${input.lossLine}"` : null,
    input.trashTalkTemplates && input.trashTalkTemplates.length > 0
      ? `Trash-talk templates: ${input.trashTalkTemplates.map((t) => `"${t}"`).join(", ")}`
      : null,
    "",
    "Reasoning to score:",
    input.reasoning,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120,
        system: PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[voice-fidelity] Anthropic API ${res.status}: ${body.slice(0, 200)}`,
      );
      return { score: null, rationale: null };
    }
    const json = (await res.json()) as AnthropicResponse;
    const text =
      json.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
    // Expect a single-line JSON. Be liberal in what we accept — extract
    // the first {...} object if Claude wrapped it in extra prose.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn(`[voice-fidelity] no JSON in judge response: ${text.slice(0, 200)}`);
      return { score: null, rationale: null };
    }
    const parsed = JSON.parse(match[0]) as { score?: number; rationale?: string };
    const score = typeof parsed.score === "number" ? parsed.score : null;
    if (score == null || score < 0 || score > 1 || Number.isNaN(score)) {
      console.warn(`[voice-fidelity] invalid score: ${parsed.score}`);
      return { score: null, rationale: parsed.rationale ?? null };
    }
    return { score, rationale: parsed.rationale ?? null };
  } catch (err) {
    console.warn(
      `[voice-fidelity] judge call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { score: null, rationale: null };
  }
}
