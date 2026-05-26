/**
 * Thin fetch wrapper for /api/v1/* REST mirror. Handles:
 *   - bearer auth (Authorization: Bearer ack_*)
 *   - long-poll timeouts (wait=true&waitMs=50000)
 *   - the canonical {ok, data, error} envelope
 *
 * Every method returns the parsed body with a discriminated union:
 *   { ok: true, status, data }
 *   { ok: false, status, error: { code, message, details?, hint? } }
 *
 * Network errors / non-JSON responses are surfaced as
 *   { ok: false, status: 0, error: { code: 'network_error', message } }
 * so the runner can categorize them.
 */
import { ORIGIN, FETCH_TIMEOUT_MS } from "./config";

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  hint?: string;
}

export type ApiResponse<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiError };

interface FetchOpts {
  /** AbortController timeout in ms. Defaults to FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  ctrl: AbortController,
): Promise<T> {
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise;
  } finally {
    clearTimeout(t);
  }
}

async function doFetch<T = unknown>(
  url: string,
  init: RequestInit,
  opts: FetchOpts = {},
): Promise<ApiResponse<T>> {
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  try {
    const res = await withTimeout(
      fetch(url, { ...init, signal: ctrl.signal }),
      timeoutMs,
      ctrl,
    );
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      return {
        ok: false,
        status: res.status,
        error: {
          code: "non_json_response",
          message: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        },
      };
    }
    // Canonical envelope
    if (
      body !== null &&
      typeof body === "object" &&
      "ok" in (body as Record<string, unknown>)
    ) {
      const env = body as {
        ok: boolean;
        data?: T;
        error?: ApiError;
      };
      if (env.ok === true) {
        return { ok: true, status: res.status, data: env.data as T };
      }
      return {
        ok: false,
        status: res.status,
        error: env.error ?? {
          code: "unknown_error",
          message: "non-ok envelope without error field",
        },
      };
    }
    // Some endpoints (auth failures) return naked error shapes
    return {
      ok: false,
      status: res.status,
      error: {
        code: `http_${res.status}`,
        message: `unexpected envelope: ${JSON.stringify(body).slice(0, 200)}`,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAbort =
      e instanceof Error && (e.name === "AbortError" || /abort/i.test(msg));
    return {
      ok: false,
      status: 0,
      error: {
        code: isAbort ? "timeout" : "network_error",
        message: msg,
      },
    };
  }
}

export interface ApiClient {
  /** POST /v1/<path> with a JSON body. */
  post<T = unknown>(
    path: string,
    body: unknown,
    opts?: FetchOpts,
  ): Promise<ApiResponse<T>>;
  /** GET /v1/<path> (with query string baked in if needed). */
  get<T = unknown>(path: string, opts?: FetchOpts): Promise<ApiResponse<T>>;
}

export function makeApi(bearer: string): ApiClient {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  return {
    async post<T>(path: string, body: unknown, opts?: FetchOpts) {
      return doFetch<T>(
        `${ORIGIN}${path}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        opts,
      );
    },
    async get<T>(path: string, opts?: FetchOpts) {
      return doFetch<T>(`${ORIGIN}${path}`, { method: "GET", headers }, opts);
    },
  };
}
