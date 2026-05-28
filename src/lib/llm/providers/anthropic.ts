/**
 * Anthropic provider — Claude family models.
 *
 * Endpoint: https://api.anthropic.com/v1/messages
 * Auth:     x-api-key header (NOT Bearer)
 * Format:   /v1/messages — distinct shape from OpenAI's chat/completions
 *
 * Vendor docs: https://docs.anthropic.com/en/api/messages
 *
 * We use raw fetch (no @anthropic-ai/sdk dep) to keep deploy size
 * lean. The /v1/messages shape is small and stable enough that
 * raw fetch is fine.
 */
import "server-only";
import {
  LlmError,
  type LlmProvider,
  type LlmCallArgs,
  type LlmCallResult,
  type ModelInfo,
} from "../types";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-7-20260101",
    name: "Claude Opus 4.7",
    bestFor: "Strongest reasoning; flagship for serious chess/strategy play",
  },
  {
    id: "claude-sonnet-4-5-20251101",
    name: "Claude Sonnet 4.5",
    bestFor: "Balanced cost/quality; great default for most games",
  },
  {
    id: "claude-haiku-4-20250801",
    name: "Claude Haiku 4",
    bestFor: "Fastest + cheapest; good for high-volume simple games",
  },
];

export const anthropicProvider: LlmProvider = {
  id: "anthropic",
  name: "Anthropic Claude",
  models: MODELS,

  async validateKey({ apiKey, model }) {
    // Cheapest validation: a 1-token request. If the auth is good
    // and the model id is valid, Anthropic returns 200; otherwise
    // 401/400/404 with a clear error message.
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (res.ok) return true;
    const body = await safeJson(res);
    throw new LlmError(
      classifyStatus(res.status),
      `Anthropic key validation failed (${res.status}): ${extractErrMessage(body)}`,
      false,
    );
  },

  async call(args: LlmCallArgs): Promise<LlmCallResult> {
    const timeoutMs = args.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: buildHeaders(args.apiKey),
        signal: controller.signal,
        body: JSON.stringify({
          model: args.model,
          max_tokens: args.maxOutputTokens ?? 2000,
          system: args.system,
          messages: [{ role: "user", content: args.user }],
        }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        throw new LlmError(
          classifyStatus(res.status),
          `Anthropic call failed (${res.status}): ${extractErrMessage(body)}`,
          isRetryable(res.status),
        );
      }
      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        stop_reason?: string;
      };
      // Anthropic responses are content blocks; we want the text from
      // the first text block. Tool-use blocks aren't applicable here
      // (we don't expose Anthropic tools to the hosted agent's loop).
      const text =
        data.content
          ?.filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("\n") ?? "";
      return {
        text,
        usage: {
          inputTokens: data.usage?.input_tokens,
          outputTokens: data.usage?.output_tokens,
        },
        finishReason: data.stop_reason,
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (controller.signal.aborted) {
        throw new LlmError("timeout", `Anthropic call timed out after ${timeoutMs}ms`, true);
      }
      throw new LlmError(
        "network",
        `Anthropic network error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  },
};

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    "content-type": "application/json",
  };
}

function classifyStatus(status: number): LlmError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "network";
  if (status === 400) return "bad_request";
  return "unknown";
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function extractErrMessage(body: unknown): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return "unknown";
}
