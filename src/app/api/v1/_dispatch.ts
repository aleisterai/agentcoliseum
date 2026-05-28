/**
 * Shared dispatcher for the `/api/v1/*` REST mirror.
 *
 * Every REST route is the same 4 steps:
 *
 *   1. Resolve bearer → Agent (or return 401/429).
 *   2. If the wrapped tool declares `paidPlayRequired`, run the same
 *      tier gate the MCP dispatcher runs (free-mode bypass via
 *      `freeModeArgs` honoured exactly the same way).
 *   3. Invoke `tool.handler(args, { agent })`.
 *   4. Wrap in the canonical envelope `{ ok: true, data }` (or
 *      `{ ok: false, error }` if the handler self-reports failure).
 *
 * Encapsulated here so the route files stay one-liners — there's no
 * place for the gating logic to drift between the 22 routes and the
 * MCP dispatcher. Single source of truth = the table at
 * `TOOLS_BY_NAME[name].paidPlayRequired/freeModeArgs`.
 *
 * Error model:
 *   - Auth/rate-limit failures → 401/429 (handled inside resolveAgentFromBearer).
 *   - Internal "tool not registered" → 500 (config bug, not a caller bug).
 *   - Tier denial / handler-reported errors → HTTP 200 with
 *     `{ ok: false, error }`. The contract here matches the MCP route's
 *     "tool-level errors don't get JSON-RPC error codes" choice, so
 *     curl scripts can branch on `.ok` regardless of transport.
 */
import { NextResponse, type NextRequest } from "next/server";
import { TOOLS_BY_NAME } from "@/app/api/mcp/tools";
import { resolveAgentFromBearer } from "@/lib/mcp-auth";
import { requirePlayAccess } from "@/lib/chain/tiers";
import { REQUEST_ID_HEADER, withRequestContext } from "@/lib/log";

/**
 * Run one tool by name with the given args, applying the same auth +
 * paid-play tier gate the MCP dispatcher applies. Returns a NextResponse
 * suitable for direct return from the route handler.
 *
 * Wraps the entire flow in `withRequestContext` so downstream
 * `log.*` calls automatically pick up `{requestId, agentId}`. The
 * requestId comes from the edge middleware via `x-request-id`; if
 * the header is absent (direct internal hit, tests) we mint one.
 */
export async function dispatchTool(
  req: Request,
  toolName: string,
  args: Record<string, unknown>,
): Promise<NextResponse> {
  const requestId =
    req.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
  return withRequestContext({ requestId }, () =>
    dispatchToolInner(req, toolName, args),
  );
}

async function dispatchToolInner(
  req: Request,
  toolName: string,
  args: Record<string, unknown>,
): Promise<NextResponse> {
  // 1. Auth + rate limit + lastMcpAt stamp.
  const auth = await resolveAgentFromBearer(req);
  if ("error" in auth) return auth.error;
  const { agent } = auth;

  // 2. Tool lookup. A missing tool here = config bug (the route file
  //    is hard-coded to a name that's not registered). 500, not 404.
  const tool = TOOLS_BY_NAME[toolName];
  if (!tool) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "tool_missing",
          message: `internal: tool '${toolName}' not registered`,
        },
      },
      { status: 500 },
    );
  }

  // Layer agentId onto the context once the bearer resolves. Inner
  // call merges with the outer scope's requestId — see log.ts.
  return withRequestContext({ agentId: agent.id }, async () => {
    // 3. Paid-play tier gate — mirrors src/app/api/mcp/route.ts.
    //    The MCP route surfaces the denial as a tool-level result; we do
    //    the same here so curl scripts can branch on `.ok`.
    if (tool.paidPlayRequired) {
      const isFreeMode = tool.freeModeArgs?.(args) ?? false;
      if (!isFreeMode) {
        const access = await requirePlayAccess({
          id: agent.id,
          handle: agent.handle,
          linkedWalletAddress: agent.linkedWalletAddress,
          paidGamesPlayed: agent.paidGamesPlayed,
        });
        if (!access.ok) {
          return NextResponse.json({
            ok: false,
            error: {
              code: access.code,
              message: access.message,
              details: access.details,
              hint: access.hint,
            },
          });
        }
      }
    }

    // 4. Invoke. The handler returns the result body directly; we wrap
    //    in the REST envelope.
    //
    //    Some handlers self-report errors by returning a shape that
    //    starts with `error: "..."` or `ok: false, error: {...}`. We
    //    detect those and re-shape into the standard REST envelope so
    //    the caller sees the same surface regardless of which kind of
    //    failure happened.
    try {
      const result = await tool.handler(args, { agent });
      return NextResponse.json(rewrapResult(result));
    } catch (e) {
      // Unhandled exception from the handler — not the normal error path.
      // Still HTTP 200 so curl scripts can branch on .ok.
      return NextResponse.json({
        ok: false,
        error: {
          code: "internal_error",
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  });
}

/**
 * Translate a handler return value into the canonical REST envelope.
 *
 * Tool handlers historically use two failure conventions:
 *
 *   1. `{ ok: false, error: { code, message, ... } }` — modern shape
 *      produced by `_shared.toToolError` and the wallet/tier tools.
 *   2. `{ error: "validation_failed: …" }` or `{ error: "match_not_found" }`
 *      — older shape used by a handful of handlers that pre-date the
 *      shared error helper.
 *
 * Either way the REST mirror surfaces it under the same `{ ok, error }`
 * envelope the spec calls for; on success the data goes under `data`.
 */
function rewrapResult(result: unknown): {
  ok: boolean;
  data?: unknown;
  error?: unknown;
} {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.ok === false && r.error) {
      return { ok: false, error: r.error };
    }
    if (typeof r.error === "string") {
      return {
        ok: false,
        error: { code: "tool_error", message: r.error },
      };
    }
  }
  return { ok: true, data: result };
}

/**
 * Parse the request body as JSON, returning either the parsed object
 * or a NextResponse with HTTP 400 + a standard error envelope. Saves
 * every POST/PATCH route from duplicating the same try/catch.
 */
export async function parseJsonBody(
  req: NextRequest,
): Promise<{ body: Record<string, unknown> } | { error: NextResponse }> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    return { body };
  } catch {
    return {
      error: NextResponse.json(
        {
          ok: false,
          error: {
            code: "invalid_body",
            message: "request body must be valid JSON",
          },
        },
        { status: 400 },
      ),
    };
  }
}
