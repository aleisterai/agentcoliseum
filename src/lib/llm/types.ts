/**
 * LLM provider abstraction for Hosted Agent Mode.
 *
 * One interface, N implementations. The hosted-agent worker calls
 * `callLlm(args)` on the provider instance for an agent's current
 * config; the provider hits the corresponding vendor endpoint with
 * the owner's API key. Adding a new provider = one new file in
 * `./providers/` that exports an `LlmProvider` and registers itself
 * in `./registry.ts`.
 *
 * Why a custom abstraction instead of using each vendor's SDK:
 *   - Vercel deploy size: 6 SDKs would each pull MB of code
 *   - The MCP server lives in a Next.js edge-adjacent runtime; raw
 *     fetch is the lowest-common-denominator that works everywhere
 *   - We need uniform error handling, retry semantics, and timeout
 *     enforcement across all providers — easier to implement once
 *     here than to wrap N SDKs
 */
import "server-only";

/**
 * Provider IDs are stored as plain text in `hosted_agent_configs.llm_provider`
 * (not an enum) so adding a provider doesn't require a schema migration.
 * The registry is the runtime source of truth.
 */
export type ProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "grok"
  | "kimi"
  | "deepseek";

export interface ModelInfo {
  /** Vendor's canonical model id. Sent verbatim in the API call. */
  id: string;
  /** Human-readable label for the dashboard dropdown. */
  name: string;
  /**
   * One-line capability hint shown in the dashboard. Optional —
   * "Best for: …" style. Kept short; LLM choice is the operator's
   * job, not ours.
   */
  bestFor?: string;
}

export interface LlmProvider {
  id: ProviderId;
  /** Display name for the dashboard provider picker. */
  name: string;
  /**
   * The list of models the owner can choose from. Comes from a hard-
   * coded table per provider — vendor model catalogues don't change
   * fast enough to need a live API call here, and the dashboard
   * shouldn't depend on the LLM provider being reachable when the
   * owner is configuring their agent.
   */
  models: ModelInfo[];
  /**
   * Validate that an API key is well-formed AND can authenticate
   * against the provider's endpoint. Called by the enable tool before
   * encrypting and storing the key — so an owner who pastes a typo
   * gets immediate feedback, not a silent failure when their agent
   * first tries to play.
   *
   * Returns true on success. Throws an Error with a human-readable
   * message on failure (the enable tool surfaces the message to the
   * owner).
   */
  validateKey(args: { apiKey: string; model: string }): Promise<boolean>;
  /**
   * The core inference call. Given a system + user prompt, returns
   * the LLM's response text. Implementation handles:
   *   - vendor-specific request shape (Anthropic /v1/messages vs
   *     OpenAI /v1/chat/completions vs Gemini :generateContent)
   *   - timeout enforcement (default ~30s; the worker can extend)
   *   - error normalization (rate limit vs auth vs network vs model
   *     refusal)
   *
   * Returns the raw text the LLM produced. Parsing into a move
   * payload + voice fields is the response-parser's job (one parser
   * for all providers).
   */
  call(args: LlmCallArgs): Promise<LlmCallResult>;
}

export interface LlmCallArgs {
  apiKey: string;
  model: string;
  /** System prompt: voice rules, game rules, output contract. */
  system: string;
  /**
   * User prompt: the live match state + the explicit "make your move"
   * instruction. Built by `prompt-builder.ts`.
   */
  user: string;
  /**
   * Max output tokens. Default ~2000; enough for a 1000-char
   * reasoning + a move payload + voice fields.
   */
  maxOutputTokens?: number;
  /**
   * Hard timeout in ms. Default 30s. The hosted-agent worker uses
   * something tighter than the per-move clock floor (120s for the
   * fastest game) so it has time to parse + submit the move.
   */
  timeoutMs?: number;
}

export interface LlmCallResult {
  /** Raw text the model produced. */
  text: string;
  /** Token usage, if the provider reports it. Best-effort accounting. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /** Vendor-specific finish reason. Useful for debugging. */
  finishReason?: string;
}

/**
 * Standard error thrown by all providers. The hosted-agent worker
 * branches on `.kind` for retry policy + dashboard surface text.
 */
export class LlmError extends Error {
  constructor(
    public kind:
      | "auth"
      | "rate_limit"
      | "timeout"
      | "network"
      | "bad_request"
      | "model_refusal"
      | "unknown",
    message: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
