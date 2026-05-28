/**
 * Shared client for OpenAI-compatible chat-completions endpoints.
 *
 * Many providers (OpenAI, Grok, Kimi/Moonshot, DeepSeek, Together,
 * Groq inference, etc.) expose the same /v1/chat/completions API
 * shape. They differ only in:
 *   - base URL
 *   - model IDs
 *   - sometimes a tiny header quirk (e.g. organization header)
 *
 * This client takes the per-provider differences as arguments. Each
 * concrete provider file (./openai.ts, ./grok.ts, ./kimi.ts,
 * ./deepseek.ts) calls in with its base URL + model list.
 */
import "server-only";
import {
  LlmError,
  type LlmCallArgs,
  type LlmCallResult,
} from "../types";

export interface OpenAICompatConfig {
  /** Provider id for error messages. */
  providerName: string;
  /** Base URL without trailing slash. e.g. "https://api.openai.com" */
  baseUrl: string;
  /**
   * Extra HTTP headers to send on every request. Defaults to none;
   * OpenAI orgs / Anthropic-style anti-fraud headers can be added per
   * provider. The Authorization header is set automatically.
   */
  extraHeaders?: Record<string, string>;
}

/**
 * Validate an API key against the chat-completions endpoint by
 * sending a 1-token request. Mirrors the validation strategy used
 * by the Anthropic provider.
 */
export async function openAICompatValidate(
  config: OpenAICompatConfig,
  apiKey: string,
  model: string,
): Promise<boolean> {
  const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: buildHeaders(apiKey, config.extraHeaders),
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
    `${config.providerName} key validation failed (${res.status}): ${extractErrMessage(body)}`,
    false,
  );
}

/**
 * Invoke chat-completions. Returns the assistant message text.
 */
export async function openAICompatCall(
  config: OpenAICompatConfig,
  args: LlmCallArgs,
): Promise<LlmCallResult> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: buildHeaders(args.apiKey, config.extraHeaders),
      signal: controller.signal,
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxOutputTokens ?? 2000,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await safeJson(res);
      throw new LlmError(
        classifyStatus(res.status),
        `${config.providerName} call failed (${res.status}): ${extractErrMessage(body)}`,
        isRetryable(res.status),
      );
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      },
      finishReason: data.choices?.[0]?.finish_reason,
    };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (controller.signal.aborted) {
      throw new LlmError("timeout", `${config.providerName} call timed out after ${timeoutMs}ms`, true);
    }
    throw new LlmError(
      "network",
      `${config.providerName} network error: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

function buildHeaders(
  apiKey: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    ...extra,
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
