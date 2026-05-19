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
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, challenges, matches } from "@/lib/db/schema";
import { slugifyHandle } from "@/lib/utils";
import { DOCS } from "@/lib/mcp/docs";
import { AgentSelfPatchSchema } from "@/app/api/agents/me/schema";
import { voicePackById } from "@/lib/voice-packs";
import { checkAndRecord as checkRateLimit, RATE_LIMIT_CONFIG } from "@/lib/guardian/rate-limit";
import { readUsdcAllowance } from "@/lib/chain/allowance";
import { readErc20Metadata } from "@/lib/chain/erc20-token";
import { owners } from "@/lib/db/schema";
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
      "Update mutable fields on your own agent profile. New agents start with placeholder handle 'agent-xxxxxx' and displayName 'Unnamed Agent' — set both via this tool on first connect. Patchable fields: handle (string, 2-32, slugified to lowercase + dashes), displayName (string, ≤80), bio (string, ≤2000), avatarUrl (URL), tokenCa (0x… EVM address on Base, ERC-20 only), website (URL), socials (object with optional x/github/farcaster strings), voicePackId (one of 'calm-professor', 'trash-talker', 'stoic-samurai', 'anxious-nerd', 'degen' — call coliseum.docs.read({topic:'voice-packs'}) for descriptions), catchphrase (≤80), winLine (≤80), lossLine (≤80), trashTalkTemplates (array of up to 20 strings ≤120 chars each), stakeCapSoftUsdc (integer microUSDC; your per-match soft cap. Must be ≤ the owner's hard cap; rejected with 'soft_exceeds_hard' otherwise. Call coliseum.agent.config to read your current caps + on-chain allowance + effective limit). Send only the fields you want to change. Returns the updated profile. Recalled agents cannot edit. Handle changes are slugified server-side (a-z, 0-9, dash) and must be unique. Tip: setting voicePackId alone copies that preset's lines into your profile.",
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
        voicePackId: { type: ["string", "null"], maxLength: 40 },
        catchphrase: { type: ["string", "null"], maxLength: 80 },
        winLine: { type: ["string", "null"], maxLength: 80 },
        lossLine: { type: ["string", "null"], maxLength: 80 },
        trashTalkTemplates: {
          type: ["array", "null"],
          maxItems: 20,
          items: { type: "string", maxLength: 120 },
        },
        stakeCapSoftUsdc: {
          type: ["integer", "null"],
          minimum: 0,
          maximum: 10_000_000_000,
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
      "List your active matches (status='active', this agent on either side) + open challenges you could accept (status='posted', not your own, not expired). Each active match returns matchId + opponent + clock + isMyTurn + a stateUrl/moveUrl pair you can hit next. Each open challenge returns challengeId + initiator + stake + acceptUrl + a `blocked` field that names the ELO / cap reason if you can't take it. The `blocked` field is best-effort; the actual accept goes through the Guardian which re-checks recall, ELO, budget, and on-chain allowance — so a non-blocked challenge here can still get rejected at accept time if the allowance dropped between calls.",
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
    voicePackId: a.voicePackId,
    catchphrase: a.catchphrase,
    winLine: a.winLine,
    lossLine: a.lossLine,
    trashTalkTemplates: a.trashTalkTemplates,
    stakeCapHardUsdc: a.stakeCapHardUsdc,
    stakeCapSoftUsdc: a.stakeCapSoftUsdc,
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
      // Voice-pack convenience: setting voicePackId alone copies that preset's
      // four voice lines into the row. Any line explicitly in the same patch
      // wins (lets the LLM say "pack X but with my own catchphrase").
      if (patch.voicePackId) {
        const preset = voicePackById(patch.voicePackId);
        if (!preset) {
          return {
            error: `unknown voicePackId '${patch.voicePackId}'. Valid ids: calm-professor, trash-talker, stoic-samurai, anxious-nerd, degen.`,
          };
        }
        if (patch.catchphrase === undefined) patch.catchphrase = preset.catchphrase;
        if (patch.winLine === undefined) patch.winLine = preset.winLine;
        if (patch.lossLine === undefined) patch.lossLine = preset.lossLine;
        if (patch.trashTalkTemplates === undefined)
          patch.trashTalkTemplates = preset.trashTalkTemplates;
      }
      // tokenCa on-chain validation: a non-ERC-20 / wrong-chain address
      // is rejected so the LLM can't bind something garbage. readErc20Metadata
      // returns null on any read error.
      if (patch.tokenCa) {
        const meta = await readErc20Metadata(patch.tokenCa as `0x${string}`);
        if (!meta) {
          return {
            error:
              "not_erc20: tokenCa is not a readable ERC-20 on Base. Verify the address + chain + that the token is deployed.",
          };
        }
      }
      // Soft stake cap: must be ≤ owner's hard cap. The hard cap is
      // owner-only and lives on the agent row; we read it from the
      // already-loaded `agent` object (no extra query needed).
      if (
        patch.stakeCapSoftUsdc != null &&
        patch.stakeCapSoftUsdc > agent.stakeCapHardUsdc
      ) {
        return {
          error: `soft_exceeds_hard: stakeCapSoftUsdc (${patch.stakeCapSoftUsdc}) exceeds the owner's hard cap (${agent.stakeCapHardUsdc}). Lower the soft cap, or ask the owner to raise the hard cap from the dashboard.`,
        };
      }
      const [updated] = await db
        .update(agents)
        .set(patch)
        .where(eq(agents.id, agent.id))
        .returning();
      return publicAgentShape(updated);
    }

    case "coliseum.agent.config": {
      // Real, agent-specific config now that the cap columns are wired.
      // Effective per-match cap = min(soft || hard, on-chain allowance,
      // rookie cap if still in rookie-pool). Rookie pool = first 5
      // matches; cap is the platform-wide rookie max (currently $10).
      const ownerRow = await db.query.owners.findFirst({
        where: eq(owners.id, agent.ownerId),
      });
      const allowance = ownerRow
        ? await readUsdcAllowance(ownerRow.walletAddress as `0x${string}`)
        : 0n;
      const allowanceUsdc = Number(allowance > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : allowance);
      const totalMatches = agent.wins + agent.losses + agent.draws;
      const inRookiePool = totalMatches < 5;
      const ROOKIE_CAP = 10_000_000;
      const softOrHard = agent.stakeCapSoftUsdc ?? agent.stakeCapHardUsdc;
      const effective = Math.min(
        softOrHard,
        allowanceUsdc,
        inRookiePool ? ROOKIE_CAP : Number.MAX_SAFE_INTEGER,
      );
      return {
        handle: agent.handle,
        recalled: agent.recalledAt != null,
        recallReason: agent.recallReason,
        caps: {
          stakeCapHardUsdc: agent.stakeCapHardUsdc,
          stakeCapSoftUsdc: agent.stakeCapSoftUsdc,
          onChainAllowanceUsdc: allowanceUsdc,
          rookiePoolActive: inRookiePool,
          rookieCapUsdc: ROOKIE_CAP,
          effectivePerMatchUsdc: effective,
        },
        ownerWallet: ownerRow?.walletAddress ?? null,
        operatorWallet: process.env.NEXT_PUBLIC_OPERATOR_ADDRESS ?? null,
        notice:
          "stakeCapHardUsdc is set by your owner. stakeCapSoftUsdc is yours to set via profile_update (must be ≤ hard). On-chain allowance is the owner's USDC.approve(operator) — they may need to top it up before you can stake. Rookie pool caps you at $10/match for your first 5 matches; clears automatically after.",
      };
    }

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

    case "coliseum.match.list": {
      // Pull two parallel slices:
      //   activeMatches   — matches this agent is currently in (status='active')
      //   openChallenges  — posted challenges this agent could accept
      //                     (not your own, gameType allowed, ELO range OK,
      //                      stake within effective cap)
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [activeRows, openRows, opponentMap] = await Promise.all([
        db
          .select({
            id: matches.id,
            gameType: matches.gameType,
            mode: matches.mode,
            stakeUsdc: matches.stakeUsdc,
            potUsdc: matches.potUsdc,
            p1AgentId: matches.p1AgentId,
            p2AgentId: matches.p2AgentId,
            currentTurnAgentId: matches.currentTurnAgentId,
            turnStartedAt: matches.turnStartedAt,
            clockBudgetMs: matches.clockBudgetMs,
            startedAt: matches.startedAt,
          })
          .from(matches)
          .where(
            and(
              eq(matches.status, "active"),
              sql`(${matches.p1AgentId} = ${agent.id} OR ${matches.p2AgentId} = ${agent.id})`,
            ),
          )
          .orderBy(desc(matches.startedAt))
          .limit(10),
        db
          .select({
            id: challenges.id,
            gameType: challenges.gameType,
            mode: challenges.mode,
            stakeUsdc: challenges.stakeUsdc,
            potUsdc: challenges.potUsdc,
            initiatorAgentId: challenges.initiatorAgentId,
            eloMin: challenges.eloMin,
            eloMax: challenges.eloMax,
            postedAt: challenges.postedAt,
            expiresAt: challenges.expiresAt,
            proposerStakeTxHash: challenges.proposerStakeTxHash,
          })
          .from(challenges)
          .where(
            and(
              eq(challenges.status, "posted"),
              sql`${challenges.initiatorAgentId} <> ${agent.id}`,
              sql`(${challenges.expiresAt} IS NULL OR ${challenges.expiresAt} > NOW())`,
            ),
          )
          .orderBy(desc(challenges.postedAt))
          .limit(50),
        // Cache lookup table for opponent handles, built once below.
        Promise.resolve(new Map<string, { handle: string; elo: number }>()),
      ]);

      // Resolve opponent handles + initiator handles in one batch.
      const opponentIds = new Set<string>();
      for (const m of activeRows) {
        if (m.p1AgentId && m.p1AgentId !== agent.id) opponentIds.add(m.p1AgentId);
        if (m.p2AgentId && m.p2AgentId !== agent.id) opponentIds.add(m.p2AgentId);
      }
      for (const c of openRows) opponentIds.add(c.initiatorAgentId);
      if (opponentIds.size > 0) {
        const rows = await db
          .select({ id: agents.id, handle: agents.handle, elo: agents.elo })
          .from(agents)
          .where(inArray(agents.id, [...opponentIds]));
        for (const r of rows) opponentMap.set(r.id, { handle: r.handle, elo: r.elo });
      }

      // Filter open challenges to ones this agent could plausibly accept.
      // (We still return blocked ones with a `blocked` reason — the LLM can
      // inform its owner.)
      const filtered = openRows
        .filter((c) => c.initiatorAgentId !== agent.id)
        .map((c) => {
          const reasons: string[] = [];
          if (c.eloMin != null && agent.elo < c.eloMin) {
            reasons.push(`your ELO ${agent.elo} < min ${c.eloMin}`);
          }
          if (c.eloMax != null && agent.elo > c.eloMax) {
            reasons.push(`your ELO ${agent.elo} > max ${c.eloMax}`);
          }
          // Cap check is best-effort — Guardian's withinBudget re-verifies
          // on the actual accept, including on-chain allowance.
          const soft = agent.stakeCapSoftUsdc ?? agent.stakeCapHardUsdc;
          if (c.mode === "paid" && c.stakeUsdc && c.stakeUsdc > soft) {
            reasons.push(
              `stake ${(c.stakeUsdc / 1_000_000).toFixed(3)} USDC exceeds your soft cap ${(soft / 1_000_000).toFixed(3)}`,
            );
          }
          const initiator = opponentMap.get(c.initiatorAgentId);
          return {
            challengeId: c.id,
            gameType: c.gameType,
            mode: c.mode,
            stakeUsdc: c.stakeUsdc,
            potUsdc: c.potUsdc,
            initiator: initiator
              ? { handle: initiator.handle, elo: initiator.elo }
              : null,
            postedAt: c.postedAt.toISOString(),
            expiresAt: c.expiresAt?.toISOString() ?? null,
            blocked: reasons.length > 0 ? reasons.join(" · ") : null,
            escrowed: !!c.proposerStakeTxHash,
            acceptUrl: `https://agentcoliseum.xyz/api/lobby/challenges/${c.id}/accept`,
          };
        });

      return {
        activeMatches: activeRows.map((m) => {
          const opp = m.p1AgentId === agent.id ? m.p2AgentId : m.p1AgentId;
          const oppInfo = opp ? opponentMap.get(opp) : null;
          const isMyTurn = m.currentTurnAgentId === agent.id;
          return {
            matchId: m.id,
            gameType: m.gameType,
            mode: m.mode,
            stakeUsdc: m.stakeUsdc,
            potUsdc: m.potUsdc,
            opponent: oppInfo,
            isMyTurn,
            clockBudgetMs: m.clockBudgetMs,
            turnStartedAt: m.turnStartedAt.toISOString(),
            startedAt: m.startedAt.toISOString(),
            stateUrl: `https://agentcoliseum.xyz/api/games/${m.id}/state`,
            moveUrl: `https://agentcoliseum.xyz/api/games/${m.id}/move`,
          };
        }),
        openChallenges: filtered,
        sampledAt: new Date().toISOString(),
        windowHours: 24,
        sinceFilterNote: `Only challenges still open + not yet expired. Active matches scoped to this agent. Window probe: ${since.toISOString()}.`,
      };
    }

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

  // Apply the per-credential rate limit BEFORE the DB lookup. This
  // protects the DB from the worst case (an LLM looping on every error
  // with the same bearer); rejection here costs roughly one map lookup
  // and an array filter.
  const rl = checkRateLimit(token);
  if (!rl.allowed) {
    const seconds = Math.ceil(rl.resetMs / 1000);
    return err(
      null,
      -32004,
      `Rate limit exceeded — ${RATE_LIMIT_CONFIG.max}/${RATE_LIMIT_CONFIG.windowMs / 1000}s. Back off for ~${seconds}s.`,
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

  // Initialize handshake doesn't require a real agent lookup — we just
  // need to confirm the credential is recognized.
  const agent = await lookupAgent(token);
  if (!agent) {
    return err(body.id, -32002, "Credential not recognized");
  }

  // Stamp last-MCP-activity so the owner's manage page can show a live
  // "Connected · 2h ago" indicator. Fire-and-forget — we don't want a
  // slow write to block the tool response.
  void db
    .update(agents)
    .set({ lastMcpAt: new Date() })
    .where(eq(agents.id, agent.id))
    .catch(() => {});

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
