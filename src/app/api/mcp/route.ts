/**
 * POST /api/mcp — Remote MCP server (Streamable HTTP transport).
 *
 * The "one-liner UX" — owners paste a single config block into their MCP
 * client (Claude Desktop, Cursor, Claude Code, etc.) with a URL + Bearer
 * header. No local script to download, no path placeholders, no restart-
 * to-test cycle.
 *
 * Wire format: JSON-RPC 2.0 over HTTP. Each POST is one request; we
 * respond with the result inline (no SSE streaming needed — every tool
 * call returns synchronously).
 *
 * Auth: `Authorization: Bearer ack_…` (the agent's apiKey, minted by
 * /api/agents/register or /api/agents/register/direct). The bearer
 * resolves to one agent row; all tool calls operate on that agent.
 *
 * Tools exposed (mirror the stdio fallback at public/coliseum-mcp.mjs):
 *   coliseum.docs.list / docs.read
 *   coliseum.agent.profile_get / profile_update / config / stats
 *   coliseum.match.list  (stubbed until Phase 1 matchmaking)
 */
import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";
import { slugifyHandle } from "@/lib/utils";
import { DOCS } from "@/lib/mcp/docs";
import { AgentSelfPatchSchema } from "@/app/api/agents/me/schema";
import type { Agent } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

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

function bearerFrom(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const [scheme, token] = h.split(" ", 2);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

async function lookupAgent(token: string): Promise<Agent | null> {
  return (await db.query.agents.findFirst({ where: eq(agents.apiKey, token) })) ?? null;
}

// -----------------------------------------------------------------------------
// Tool catalog — the same shape returned by tools/list, plus a handler.
// -----------------------------------------------------------------------------

const TOOLS = [
  {
    name: "coliseum.docs.list",
    description:
      "List available documentation topics. Always call first to discover what context is available.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "coliseum.docs.read",
    description:
      "Read the full markdown body of one documentation topic. Topic must be one of the ids returned by coliseum.docs.list (rules, voice-packs, scoring, games, faq).",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "coliseum.agent.profile_get",
    description:
      "Read your own agent profile (handle, displayName, bio, voice fields, coin CA, ELO, record, recall status). Use this before profile_update to see current values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "coliseum.agent.profile_update",
    description:
      "Update mutable fields on your own agent profile. New agents start with placeholder handle 'agent-xxxxxx' and displayName 'Unnamed Agent' — set both via this tool on first connect. Patchable fields: handle (string, 2-32, slugified to lowercase + dashes), displayName (string, ≤80), bio (string, ≤2000), avatarUrl (URL), tokenCa (0x… EVM address on Base, ERC-20 only), website (URL), socials (object with optional x/github/farcaster strings). Send only the fields you want to change. Returns the updated profile. Recalled agents cannot edit. Handle changes are slugified server-side (a-z, 0-9, dash) and must be unique.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", minLength: 2, maxLength: 32 },
        displayName: { type: "string", maxLength: 80 },
        bio: { type: ["string", "null"], maxLength: 2000 },
        avatarUrl: { type: ["string", "null"], format: "uri" },
        tokenCa: {
          type: ["string", "null"],
          pattern: "^0x[a-fA-F0-9]{40}$",
        },
        website: { type: ["string", "null"], format: "uri" },
        socials: {
          type: ["object", "null"],
          properties: {
            x: { type: "string", maxLength: 80 },
            github: { type: "string", maxLength: 80 },
            farcaster: { type: "string", maxLength: 80 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "coliseum.agent.config",
    description:
      "Read your owner-configured spending limits + recall status. Stay within these limits — proposing over the maxStakeUsdc is rejected server-side.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "coliseum.agent.stats",
    description:
      "Read your competitive stats: ELO, win/loss/draw, recent matches (last 20 with opponent + stake + outcome).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "coliseum.match.list",
    description:
      "List your active matches + open challenges you can accept. Phase 1 will fill this with real matchmaking; today returns an empty list + a notice.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];

function publicAgentShape(a: Agent) {
  return {
    id: a.id,
    handle: a.handle,
    displayName: a.displayName,
    bio: a.bio,
    avatarUrl: a.avatarUrl,
    tokenCa: a.tokenCa,
    website: a.website,
    socials: a.socials,
    elo: a.elo,
    wins: a.wins,
    losses: a.losses,
    draws: a.draws,
    recalledAt: a.recalledAt?.toISOString() ?? null,
    recalledBy: a.recalledBy,
    recallReason: a.recallReason,
    createdAt: a.createdAt.toISOString(),
  };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  agent: Agent,
): Promise<unknown> {
  switch (name as ToolName) {
    case "coliseum.docs.list":
      return {
        topics: Object.entries(DOCS).map(([id, doc]) => ({ id, title: doc.title })),
      };

    case "coliseum.docs.read": {
      const topic = String(args.topic ?? "");
      const doc = DOCS[topic];
      if (!doc) {
        return {
          error: `unknown topic '${topic}'. Available: ${Object.keys(DOCS).join(", ")}`,
        };
      }
      return { topic, title: doc.title, markdown: doc.body };
    }

    case "coliseum.agent.profile_get":
      return publicAgentShape(agent);

    case "coliseum.agent.profile_update": {
      if (agent.recalledAt) {
        return {
          error: `Recalled agents can't edit their profile. Owner clears the recall in the dashboard. Reason: ${agent.recallReason ?? "—"}`,
        };
      }
      const parsed = AgentSelfPatchSchema.safeParse(args);
      if (!parsed.success) {
        return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const patch = parsed.data;
      if (Object.keys(patch).length === 0) {
        return { error: "empty patch — supply at least one field" };
      }
      if (patch.handle != null) {
        const slug = slugifyHandle(patch.handle);
        if (slug.length < 2) return { error: "handle too short after slugify" };
        if (slug !== agent.handle) {
          const collision = await db.query.agents.findFirst({
            where: eq(agents.handle, slug),
          });
          if (collision && collision.id !== agent.id) {
            return { error: `handle '${slug}' already taken` };
          }
        }
        patch.handle = slug;
      }
      const [updated] = await db
        .update(agents)
        .set(patch)
        .where(eq(agents.id, agent.id))
        .returning();
      return publicAgentShape(updated);
    }

    case "coliseum.agent.config":
      return {
        handle: agent.handle,
        recalled: agent.recalledAt != null,
        recallReason: agent.recallReason,
        defaults: {
          maxStakeUsdc: 10_000_000,
          dailyLossUsdc: 25_000_000,
          eloFloorDelta: 150,
          rookieMaxStakeUsdc: 10_000_000,
          rookieMatches: 5,
        },
        notice:
          "Phase 1 will surface owner-set spending limits via this endpoint. For now treat these as the platform-wide defaults.",
      };

    case "coliseum.agent.stats": {
      const recent = await db
        .select({
          id: matches.id,
          gameType: matches.gameType,
          mode: matches.mode,
          status: matches.status,
          p1AgentId: matches.p1AgentId,
          p2AgentId: matches.p2AgentId,
          winnerAgentId: matches.winnerAgentId,
          stakeUsdc: matches.stakeUsdc,
          potUsdc: matches.potUsdc,
          startedAt: matches.startedAt,
          completedAt: matches.completedAt,
        })
        .from(matches)
        .where(
          and(or(eq(matches.p1AgentId, agent.id), eq(matches.p2AgentId, agent.id))),
        )
        .orderBy(desc(matches.startedAt))
        .limit(20);
      return {
        handle: agent.handle,
        elo: agent.elo,
        record: { wins: agent.wins, losses: agent.losses, draws: agent.draws },
        recentMatches: recent.map((m) => ({
          ...m,
          startedAt: m.startedAt?.toISOString() ?? null,
          completedAt: m.completedAt?.toISOString() ?? null,
          outcome:
            m.status === "completed"
              ? m.winnerAgentId === agent.id
                ? "win"
                : m.winnerAgentId
                  ? "loss"
                  : "draw"
              : null,
        })),
      };
    }

    case "coliseum.match.list":
      return {
        activeMatches: [],
        openChallenges: [],
        notice:
          "Match list ships in Phase 1 once the on-chain matchmaking backend is wired. Today, your owner can spawn matches from the dashboard.",
      };

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// -----------------------------------------------------------------------------
// JSON-RPC dispatch.
// -----------------------------------------------------------------------------

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
  const token = bearerFrom(req);
  if (!token) {
    return err(null, -32001, "Missing Bearer token. Set Authorization: Bearer <your-agent-credential>.");
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

  // Initialize handshake doesn't require a real agent lookup — we just
  // need to confirm the credential is recognized.
  const agent = await lookupAgent(token);
  if (!agent) {
    return err(body.id, -32002, "Credential not recognized");
  }

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
        // Notifications expect no response; ping is just a keepalive.
        return body.method === "ping"
          ? ok(body.id, {})
          : new NextResponse(null, { status: 204 });

      case "tools/list":
        return ok(body.id, { tools: TOOLS });

      case "tools/call": {
        const { name, arguments: argsRaw = {} } = ToolCallParams.parse(body.params ?? {});
        const result = await runTool(name, argsRaw, agent);
        return ok(body.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      }

      default:
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
