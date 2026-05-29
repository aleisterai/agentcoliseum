/**
 * Bearer-token → Agent resolution, shared by the MCP JSON-RPC route at
 * `/api/mcp` and the REST mirror at `/api/v1/*`.
 *
 * Auth model is identical to the MCP route (lifted verbatim) so both
 * transports remain a single source of truth for credential semantics:
 *
 *   - Accepts `acoth_…` (OAuth access tokens minted via /api/mcp/oauth/*)
 *     and `ack_…` (legacy direct agent apiKey).
 *   - Per-bearer rate limit BEFORE the DB lookup so a runaway LLM is
 *     rejected cheaply.
 *   - Records `agents.lastMcpAt` fire-and-forget so the dashboard's
 *     "Connected · Xm ago" indicator stays fresh.
 *
 * The high-level entry point is `resolveAgentFromBearer(req)`. It runs
 * the full pipeline and returns either the resolved Agent or a
 * `NextResponse` already shaped with the right HTTP status + JSON body
 * for the REST mirror. The MCP JSON-RPC route uses the lower-level
 * primitives (`bearerFrom`, `checkBearerRateLimit`, `lookupAgentByToken`,
 * `stampLastMcpAt`) directly because it needs to format errors as
 * JSON-RPC envelopes, not HTTP responses.
 */
import { NextResponse } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, mcpOauthTokens } from "@/lib/db/schema";
import { defaultProviderFromClient } from "@/lib/llm/agent-llm";
import {
  checkAndRecord as checkRateLimit,
  RATE_LIMIT_CONFIG,
} from "@/lib/guardian/rate-limit";
import { TOKEN_PREFIX as OAUTH_TOKEN_PREFIX } from "@/lib/mcp-oauth";
import type { Agent } from "@/lib/db/schema";

/** Result of bearer resolution. On success returns the resolved agent;
 *  on failure returns a NextResponse already populated with the right
 *  HTTP status (401 for missing/invalid bearer, 429 for rate limit). */
export type ResolveAgentResult =
  | { agent: Agent }
  | { error: NextResponse };

/** Pull the raw token out of `Authorization: Bearer <token>`. Returns
 *  null on any malformed header. Lowercase-tolerant. */
export function bearerFrom(req: Request): string | null {
  const h =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const [scheme, token] = h.split(" ", 2);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

/**
 * Resolve a Bearer token to an agent. Accepts two formats:
 *
 *   - `acoth_…` — OAuth access token minted by /api/mcp/oauth/token.
 *     The token row carries the agentId bound at consent time. We
 *     refuse expired or revoked rows here so the client gets a clean
 *     401 instead of leaking through.
 *
 *   - `ack_…`   — legacy direct agent apiKey, used by Claude Desktop
 *     (.mcpb), Cursor, Claude Code CLI, and the
 *     scripts/mcp-duel.ts harness. No expiry; rotated manually from
 *     the dashboard.
 *
 * Both lookups are single-column primary-key reads, so this stays
 * fast even with the extra branch.
 */
export async function lookupAgentByToken(token: string): Promise<Agent | null> {
  if (token.startsWith(OAUTH_TOKEN_PREFIX)) {
    const now = new Date();
    const row = await db.query.mcpOauthTokens.findFirst({
      where: and(
        eq(mcpOauthTokens.accessToken, token),
        isNull(mcpOauthTokens.revokedAt),
        gt(mcpOauthTokens.expiresAt, now),
      ),
    });
    if (!row) return null;
    return (
      (await db.query.agents.findFirst({
        where: eq(agents.id, row.agentId),
      })) ?? null
    );
  }
  return (
    (await db.query.agents.findFirst({ where: eq(agents.apiKey, token) })) ??
    null
  );
}

/** Per-bearer sliding window rate limiter. Same key namespace + limits
 *  the MCP JSON-RPC route has used since Sprint 17. Surfaced here so
 *  both transports share one counter (a runaway LLM that switches from
 *  /api/mcp to /api/v1/* can't double-dip its quota). */
export async function checkBearerRateLimit(token: string) {
  const rl = await checkRateLimit(token);
  return { ...rl, config: RATE_LIMIT_CONFIG };
}

/** Fire-and-forget `lastMcpAt` stamp. A slow write here can't delay
 *  the tool response; if it errors, we swallow. Same fire-and-forget
 *  semantics the MCP route has shipped since launch. */
export function stampLastMcpAt(agentId: string): void {
  void db
    .update(agents)
    .set({ lastMcpAt: new Date() })
    .where(eq(agents.id, agentId))
    .catch(() => {});
}

/**
 * Seed `agents.llm_provider` from the MCP client name reported on the
 * `initialize` handshake (Claude Desktop / Claude Code → Claude, the ChatGPT
 * app → OpenAI, etc.) — but ONLY when it's still unset. An explicit choice
 * (profile_update / dashboard / hosted) always wins; this never overrides it.
 * Race-safe via the `isNull` guard in the WHERE so two concurrent connects
 * can't clobber. Fire-and-forget; a no-op for multi-model clients (Cursor,
 * Cline, …) that don't reveal a model. The client name identifies the *app*,
 * not the model, so this is a best-effort default the agent can override.
 */
export function maybeSeedLlmProviderFromClient(
  agentId: string,
  current: string | null,
  clientName: string | null | undefined,
): void {
  if (current) return;
  const provider = defaultProviderFromClient(clientName);
  if (!provider) return;
  void db
    .update(agents)
    .set({ llmProvider: provider })
    .where(and(eq(agents.id, agentId), isNull(agents.llmProvider)))
    .catch(() => {});
}

/**
 * One-shot REST auth: extract bearer, rate-limit, look up agent, stamp
 * lastMcpAt, return the resolved agent or a NextResponse error shape.
 *
 * Errors are shaped as `{ ok: false, error: { code, message, hint? } }`
 * with HTTP 401 for missing/invalid bearer and HTTP 429 for rate limit
 * (matching the contract in the REST design doc).
 *
 * The MCP JSON-RPC route doesn't use this — it needs to wrap errors as
 * JSON-RPC envelopes and stamp `lastMcpAt` after a different control
 * flow. It uses the lower-level primitives directly.
 */
export async function resolveAgentFromBearer(
  req: Request,
): Promise<ResolveAgentResult> {
  const token = bearerFrom(req);
  if (!token) {
    return {
      error: NextResponse.json(
        {
          ok: false,
          error: {
            code: "missing_bearer",
            message:
              "Missing Bearer token. Set Authorization: Bearer <your-agent-credential>.",
          },
        },
        { status: 401 },
      ),
    };
  }

  const rl = await checkBearerRateLimit(token);
  if (!rl.allowed) {
    const seconds = Math.ceil(rl.resetMs / 1000);
    return {
      error: NextResponse.json(
        {
          ok: false,
          error: {
            code: "rate_limited",
            message: `Rate limit exceeded — ${rl.config.max}/${rl.config.windowMs / 1000}s. Back off for ~${seconds}s.`,
            hint: `Wait ~${seconds}s before retrying.`,
          },
        },
        {
          status: 429,
          headers: { "Retry-After": String(seconds) },
        },
      ),
    };
  }

  const agent = await lookupAgentByToken(token);
  if (!agent) {
    return {
      error: NextResponse.json(
        {
          ok: false,
          error: {
            code: "credential_not_recognized",
            message: "Credential not recognized",
          },
        },
        { status: 401 },
      ),
    };
  }

  stampLastMcpAt(agent.id);
  return { agent };
}
