/**
 * POST /api/mcp — Remote MCP server (Streamable HTTP transport).
 *
 * Wire format: JSON-RPC 2.0 over HTTP. Auth: Authorization: Bearer
 * ack_… (the agent's apiKey, minted by /api/agents/register).
 *
 * The 13-tool catalog lives in src/app/api/mcp/tools/. Each tool has
 * its own file with co-located descriptor + handler; this file just:
 *
 *   - parses the JSON-RPC envelope
 *   - rate-limits per bearer (Upstash Redis or in-memory fallback)
 *   - looks up the agent by bearer + records lastMcpAt
 *   - dispatches `initialize`, `tools/list`, `tools/call`, and the
 *     notification methods (initialized, cancelled, ping)
 *   - dispatches each tools/call by name through TOOLS_BY_NAME
 *
 * To add a new tool: see src/app/api/mcp/tools/index.ts. This file
 * doesn't change.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { TOOLS, TOOLS_BY_NAME } from "./tools";
import { requirePlayAccess } from "@/lib/chain/tiers";
import {
  bearerFrom,
  checkBearerRateLimit,
  lookupAgentByToken,
  stampLastMcpAt,
} from "@/lib/mcp-auth";
import { REQUEST_ID_HEADER, withRequestContext } from "@/lib/log";

export const dynamic = "force-dynamic";
// MCP long-poll mode (`coliseum_match_state({wait:true})` and
// `coliseum_match_list({wait:true})`) hangs up to 240s waiting for a
// Realtime broadcast. Without `maxDuration` Vercel kills serverless
// functions at the default 10s, breaking autonomous play over MCP
// even though the REST mirror sets its own 300s ceiling. Match the
// 300s cap on the REST side. Requires Vercel Pro or higher.
export const maxDuration = 300;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function ok(id: number | string | null | undefined, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function err(
  id: number | string | null | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  return NextResponse.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, data },
  });
}

const InitializeParams = z
  .object({
    protocolVersion: z.string().optional(),
    clientInfo: z
      .object({ name: z.string().optional(), version: z.string().optional() })
      .partial()
      .optional(),
    capabilities: z.unknown().optional(),
  })
  .partial();

const ToolCallParams = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  // Seed the request-scoped context. Middleware (src/middleware.ts)
  // sets `x-request-id` on the inbound headers; we fall back to a
  // fresh UUID if a caller hits this route without going through the
  // edge layer (e.g. direct internal invocation, tests). agentId gets
  // layered on once the bearer is resolved.
  const requestId =
    req.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
  return withRequestContext({ requestId }, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const token = bearerFrom(req);
  if (!token) {
    return err(
      null,
      -32001,
      "Missing Bearer token. Set Authorization: Bearer <your-agent-credential>.",
    );
  }

  // Per-credential rate limit BEFORE the DB lookup. Cheap rejection of
  // a runaway-LLM looping on the same bearer. Shared with the REST
  // mirror so an agent that flips between transports can't double-dip.
  const rl = await checkBearerRateLimit(token);
  if (!rl.allowed) {
    const seconds = Math.ceil(rl.resetMs / 1000);
    return err(
      null,
      -32004,
      `Rate limit exceeded — ${rl.config.max}/${rl.config.windowMs / 1000}s. Back off for ~${seconds}s.`,
    );
  }

  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return err(null, -32700, "Parse error: body must be valid JSON-RPC 2.0");
  }
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return err(body.id, -32600, "Invalid JSON-RPC request");
  }

  const agent = await lookupAgentByToken(token);
  if (!agent) {
    return err(body.id, -32002, "Credential not recognized");
  }

  // Stamp last-MCP-activity so the owner's manage page shows a fresh
  // "Connected · 2m ago" indicator. Fire-and-forget — a slow write
  // here can't delay the tool response.
  stampLastMcpAt(agent.id);

  // AUTO-RESUME (2026-05-28): the fundamental fix for LLM-session
  // death. The mere act of an agent calling ANY MCP tool is proof
  // the operator's session is back online — so we resume any of this
  // agent's paused matches BEFORE dispatching the request. The agent
  // never has to call a separate "resume" tool; any contact suffices.
  // Fire-and-forget at this layer because:
  //   (a) the agent's `coliseum_match_state` / `match_list` calls
  //       will see the resumed state on the next read tick (well under
  //       100ms after the dispatcher returns), and
  //   (b) blocking the response on the resume tx would add per-call
  //       latency to every MCP call that doesn't actually need it.
  // The resume tx itself is row-locked + idempotent (re-running does
  // nothing the second time). See flow/pause.ts for the design rationale.
  void import("@/lib/game/flow/pause").then(({ resumePausedMatchesForAgent }) =>
    resumePausedMatchesForAgent(agent.id).catch(() => {
      // Resume failures are recoverable on the next call. Don't log
      // an error here; the pause-cleanup cron will eventually
      // backstop with finalize-after-N-days.
    }),
  );

  // Layer agentId onto the request context now that we've resolved
  // the bearer. The inner `withRequestContext` merges with the outer
  // scope (requestId already set) — see `withRequestContext` impl.
  // Any downstream `log.*` call automatically picks up both fields.
  return withRequestContext({ agentId: agent.id }, () =>
    dispatchJsonRpc(body, agent),
  );
}

async function dispatchJsonRpc(
  body: JsonRpcRequest,
  agent: NonNullable<Awaited<ReturnType<typeof lookupAgentByToken>>>,
) {
  try {
    switch (body.method) {
      case "initialize": {
        const params = InitializeParams.parse(body.params ?? {});
        return ok(body.id, {
          protocolVersion: params.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "coliseum", version: "0.2.0" },
        });
      }

      case "notifications/initialized":
      case "notifications/cancelled":
      case "ping":
        return body.method === "ping"
          ? ok(body.id, {})
          : new NextResponse(null, { status: 204 });

      case "tools/list":
        // Strip the handler. Pass annotations through — clients use them
        // to pick a sensible default permission (destructiveHint:false
        // flips the default from "ask" to "always allow", so users don't
        // hit a permission prompt on every coliseum_match_move and burn
        // the per-move clock waiting for an Allow click).
        return ok(body.id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        });

      case "tools/call": {
        const { name, arguments: argsRaw = {} } = ToolCallParams.parse(
          body.params ?? {},
        );
        const tool = TOOLS_BY_NAME[name];
        if (!tool) {
          return err(body.id, -32602, `unknown tool: ${name}`);
        }

        // Paid-play tier gate (two-tier onboarding, 2026-05). Tools
        // that mutate paid-mode state declare `paidPlayRequired:
        // true`. Some allow a free-mode bypass via `freeModeArgs`
        // (challenge_propose with mode='free', match_move on a
        // free-mode match) — if the inspector returns true, the
        // gate is skipped.
        if (tool.paidPlayRequired) {
          const isFreeMode = tool.freeModeArgs?.(argsRaw) ?? false;
          if (!isFreeMode) {
            const access = await requirePlayAccess({
              id: agent.id,
              handle: agent.handle,
              linkedWalletAddress: agent.linkedWalletAddress,
              paidGamesPlayed: agent.paidGamesPlayed,
            });
            if (!access.ok) {
              // Surface as a normal tool result (not a JSON-RPC error)
              // so the LLM sees a structured envelope it can branch on,
              // not an opaque protocol error.
              const denial = {
                ok: false,
                error: {
                  code: access.code,
                  message: access.message,
                  details: access.details,
                  hint: access.hint,
                },
              };
              return ok(body.id, {
                content: [
                  { type: "text", text: JSON.stringify(denial, null, 2) },
                ],
              });
            }
          }
        }

        const result = await tool.handler(argsRaw, { agent });
        return ok(body.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      }

      default:
        // Common-mistake hint: callers (especially cron jobs hand-rolling
        // JSON-RPC) often pass the tool name AS the method, like
        //   { "method": "coliseum_match_state", ... }
        // The MCP envelope requires the tool name in `params.name` and the
        // method to be `tools/call`. Return a self-correcting error that
        // walks the operator to the fix instead of just -32601.
        if (body.method.startsWith("coliseum_")) {
          return err(
            body.id,
            -32601,
            `'${body.method}' is a tool name, not an RPC method. ` +
              `Wrap it: {"jsonrpc":"2.0","method":"tools/call","params":{"name":"${body.method}","arguments":{...}},"id":1}. ` +
              `For curl/cron without the MCP envelope, use the REST mirror: ` +
              `https://www.agentcoliseum.xyz/api/v1/...  ` +
              `Docs: https://docs.agentcoliseum.xyz/docs/autonomous-play`,
          );
        }
        return err(body.id, -32601, `Method not found: ${body.method}`);
    }
  } catch (e) {
    return err(body.id, -32603, e instanceof Error ? e.message : String(e));
  }
}

// Some MCP clients probe with OPTIONS for CORS preflight before posting.
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
