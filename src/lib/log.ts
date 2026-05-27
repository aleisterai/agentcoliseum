/**
 * Structured-logging foundation.
 *
 * Two pieces:
 *
 *   1. `log` — a pino logger. JSON-to-stdout in production (Vercel's
 *      log drain ingests it directly), pino-pretty in dev for human
 *      readability.
 *
 *   2. `withRequestContext` / `getRequestContext` — request-scoped
 *      context propagation via `node:async_hooks` AsyncLocalStorage.
 *      Set at the route entry (MCP `/api/mcp` and REST `/api/v1/*`);
 *      any downstream `log.*` call automatically picks up
 *      `{requestId, agentId, matchId}` without a call-site change.
 *
 * **Why pino, not custom JSON?** Pino is the de-facto standard for
 * structured Node logging — battle-tested, ~5x faster than winston, and
 * its output shape is what Vercel's "JSON log" parser expects (level
 * as a number, `time` field, `msg` field). Rolling our own would lose
 * the parser integration.
 *
 * **Why AsyncLocalStorage and not just passing ctx around?** This
 * landed as a foundation PR — converting all 37 existing console.*
 * sites in src/ is out of scope. AsyncLocalStorage means future
 * `log.error({…}, "foo failed")` calls in deep helpers inherit the
 * request context for free. The performance overhead is negligible
 * (Node has a fast path for the no-context case).
 *
 * **Edge runtime:** this module is Node-only (AsyncLocalStorage isn't
 * in the Edge runtime). The middleware at the edge generates the
 * request ID + sets the `x-request-id` header; route handlers running
 * on Node read the header and call `withRequestContext` to seed the
 * ALS. Do NOT import this file from Edge code.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger } from "pino";

/**
 * Request-scoped context. `requestId` is always present after the
 * middleware runs; `agentId` / `matchId` are set by the entry handler
 * once the bearer is resolved and (for match-specific paths) once
 * the match is known.
 */
export interface RequestContext {
  requestId: string;
  agentId?: string;
  matchId?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

/**
 * Build the base pino logger. Production = JSON to stdout (Vercel's
 * log drain ingests this verbatim). Dev = pino-pretty for human
 * readability.
 *
 * The transport target is resolved at module-load time — pino spawns
 * a worker thread for the transport, so we want exactly one instance.
 * Re-creating the logger per call would leak workers.
 */
function makeLogger(): Logger {
  const level = process.env.LOG_LEVEL ?? "info";
  const isProd = process.env.NODE_ENV === "production";
  const isTest = process.env.NODE_ENV === "test";

  // Tests: silent unless LOG_LEVEL is set explicitly. Vitest's per-test
  // output is already noisy; the structured logger shouldn't add to it.
  if (isTest && process.env.LOG_LEVEL == null) {
    return pino({ level: "silent" });
  }

  if (isProd) {
    // JSON to stdout. Add `requestId/agentId/matchId` as top-level
    // fields via the `mixin` hook so every line carries the context
    // without needing log-site changes.
    return pino({
      level,
      mixin() {
        const ctx = als.getStore();
        if (!ctx) return {};
        const out: Record<string, string> = { requestId: ctx.requestId };
        if (ctx.agentId) out.agentId = ctx.agentId;
        if (ctx.matchId) out.matchId = ctx.matchId;
        return out;
      },
    });
  }

  // Dev: pino-pretty. Wrapped in try/catch — if pino-pretty fails to
  // resolve (e.g. an esbuild dev-bundling edge case), fall back to
  // plain pino so dev doesn't crash on first log line.
  try {
    return pino({
      level,
      mixin() {
        const ctx = als.getStore();
        if (!ctx) return {};
        const out: Record<string, string> = { requestId: ctx.requestId };
        if (ctx.agentId) out.agentId = ctx.agentId;
        if (ctx.matchId) out.matchId = ctx.matchId;
        return out;
      },
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
    });
  } catch {
    return pino({ level });
  }
}

/**
 * Canonical logger. Use this in new code:
 *
 *   import { log } from "@/lib/log";
 *   log.error({ err }, "settlement-sweep payout failed");
 *
 * Old `console.error(...)` call sites keep working — this is purely
 * additive. The two will coexist until natural code churn migrates
 * everything.
 */
export const log: Logger = makeLogger();

/**
 * Run `fn` inside an AsyncLocalStorage scope carrying `ctx`. Any
 * `log.*` call inside `fn` (or anything it awaits) will automatically
 * include `ctx`'s fields in its output. Nested calls merge with the
 * outer scope on a per-field basis (later wins).
 *
 * `ctx` must include `requestId` for the OUTERMOST call (the route
 * entry). Inner calls can pass a partial — e.g. the route seeds
 * `{ requestId }` and a match handler layers `{ agentId, matchId }`
 * on top without re-passing the requestId.
 *
 *   const requestId = req.headers.get("x-request-id") ?? randomUUID();
 *   return withRequestContext({ requestId }, async () => {
 *     // ...resolve agent...
 *     return withRequestContext({ agentId: agent.id }, () => handle());
 *   });
 *
 * If `ctx` is partial and no outer scope exists, `requestId` will be
 * undefined in `getRequestContext()` and the logger's mixin — callers
 * upstream of the route entry shouldn't be in that state in practice,
 * but the type stays honest about the merge case.
 */
export function withRequestContext<T>(
  ctx: Partial<RequestContext>,
  fn: () => Promise<T> | T,
): Promise<T> {
  // Merge with any existing context so a nested call can refine fields
  // (e.g. the route adds requestId, then the match handler layers
  // matchId on top) without losing the outer fields.
  const existing = als.getStore();
  const merged = { ...(existing ?? {}), ...ctx } as RequestContext;
  return Promise.resolve(als.run(merged, fn));
}

/**
 * Read the current request context. Returns an empty object outside
 * any `withRequestContext` scope so callers can safely spread the
 * result into a log payload without a null check.
 *
 *   log.error({ ...getRequestContext(), err }, "something failed");
 *
 * Note: code inside a request handler doesn't need to call this
 * explicitly — the logger's mixin already injects the context.
 * `getRequestContext` is for code that wants to attach the context
 * to a non-pino artifact (an outbound HTTP header, an error wrapper,
 * a database audit row, etc).
 */
export function getRequestContext(): Partial<RequestContext> {
  return als.getStore() ?? {};
}

/**
 * Header name used to propagate the request ID from the middleware to
 * route handlers and downstream service calls. Exported as a constant
 * so the middleware and the route entry can't drift on the spelling.
 */
export const REQUEST_ID_HEADER = "x-request-id";
