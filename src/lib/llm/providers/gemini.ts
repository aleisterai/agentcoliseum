/**
 * Google Gemini provider — REST `:generateContent` endpoint.
 *
 * https://ai.google.dev/gemini-api/docs/text-generation
 *
 * Distinct shape from OpenAI-compatible providers:
 *   - URL: /v1beta/models/{model}:generateContent?key={api_key}
 *   - Auth: API key in query string (not Authorization header)
 *   - Body: contents[] with parts[] structure
 *   - Response: candidates[].content.parts[].text
 */
import "server-only";
import {
  LlmError,
  type LlmProvider,
  type LlmCallArgs,
  type LlmCallResult,
  type ModelInfo,
} from "../types";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MODELS: ModelInfo[] = [
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    bestFor: "Strongest Gemini reasoning",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    bestFor: "Balanced speed/quality",
  },
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    bestFor: "Cheapest + fastest",
  },
];

export const geminiProvider: LlmProvider = {
  id: "gemini",
  name: "Google Gemini",
  models: MODELS,

  async validateKey({ apiKey, model }) {
    // Smallest valid generateContent call. Same approach as the
    // other providers — auth and model resolution happen on the same
    // request that we'd be making for a real turn.
    const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    });
    if (res.ok) return true;
    const body = await safeJson(res);
    throw new LlmError(
      classifyStatus(res.status),
      `Gemini key validation failed (${res.status}): ${extractErrMessage(body)}`,
      false,
    );
  },

  async call(args: LlmCallArgs): Promise<LlmCallResult> {
    const timeoutMs = args.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${BASE}/${encodeURIComponent(args.model)}:generateContent?key=${encodeURIComponent(args.apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          // Gemini treats the system prompt as `systemInstruction`,
          // distinct from the conversation `contents`. We're stateless
          // (one user message per call) so there's no history to
          // include.
          systemInstruction: { parts: [{ text: args.system }] },
          contents: [{ role: "user", parts: [{ text: args.user }] }],
          generationConfig: {
            maxOutputTokens: args.maxOutputTokens ?? 2000,
          },
        }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        throw new LlmError(
          classifyStatus(res.status),
          `Gemini call failed (${res.status}): ${extractErrMessage(body)}`,
          isRetryable(res.status),
        );
      }
      const data = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
      };
      const text =
        data.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? "")
          .join("") ?? "";
      return {
        text,
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount,
          outputTokens: data.usageMetadata?.candidatesTokenCount,
        },
        finishReason: data.candidates?.[0]?.finishReason,
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (controller.signal.aborted) {
        throw new LlmError("timeout", `Gemini call timed out after ${timeoutMs}ms`, true);
      }
      throw new LlmError(
        "network",
        `Gemini network error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  },
};

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
