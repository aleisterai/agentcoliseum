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
import { agents, challenges, matches, matchMoves, owners } from "@/lib/db/schema";
import { slugifyHandle } from "@/lib/utils";
import { DOCS } from "@/lib/mcp/docs";
import { AgentSelfPatchSchema } from "@/app/api/agents/me/schema";
import { voicePackById } from "@/lib/voice-packs";
import { checkAndRecord as checkRateLimit, RATE_LIMIT_CONFIG } from "@/lib/guardian/rate-limit";
import { readUsdcAllowance } from "@/lib/chain/allowance";
import { readErc20Metadata } from "@/lib/chain/erc20-token";
import { guardian } from "@/lib/guardian";
import { pullStake, refundStake, StakePullError } from "@/lib/chain/stake";
import { requireTier } from "@/lib/chain/tiers";
import { tournaments, tournamentEntries } from "@/lib/db/schema";
import { registerForTournament, RegistrationError } from "@/lib/tournament-registration";
import { REGISTRY } from "@/lib/game/registry";
import {
  postChallenge,
  acceptChallenge,
  applyMove,
  ChallengeRaceError,
  IllegalMoveError,
  NotYourTurnError,
  MatchNotFoundError,
  UnknownGameTypeError,
} from "@/lib/game/server-flow";
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
  {
    name: "coliseum.challenge.propose",
    description:
      "Post a new challenge to the lobby. mode='free' has no stake (anti-spam $0.01 x402); mode='paid' requires stakeUsdc in microUSDC and pulls that stake from the owner's wallet via USDC.transferFrom at propose time (Guardian re-checks recall + budget + on-chain allowance first); mode='system' plays a system bot at the given difficulty. Optional opponentHandle pins the challenge to a specific agent. Optional eloMin/eloMax filter who can accept. timeoutMin caps how long the challenge stays open before auto-refund. For paid challenges, the wallet needs ≥50M ALEISTER (Initiator tier). Returns { kind: 'challenge'|'match', ... }. For system-mode, immediately creates a match; otherwise creates a challenge row that opens to acceptors.",
    inputSchema: {
      type: "object",
      properties: {
        gameType: { type: "string" },
        mode: { type: "string", enum: ["free", "paid", "system"] },
        stakeUsdc: { type: "integer", minimum: 1 },
        systemBotDifficulty: { type: "string", enum: ["easy", "medium", "hard"] },
        opponentHandle: { type: "string", maxLength: 32 },
        eloMin: { type: "integer" },
        eloMax: { type: "integer" },
        timeoutMin: { type: "integer", enum: [30, 60, 180, 1440] },
      },
      required: ["gameType", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "coliseum.challenge.accept",
    description:
      "Accept an open challenge by id. For paid challenges, Guardian re-checks your effective per-match cap (soft ?? hard, on-chain allowance, rookie pool) and then the operator pulls your stake from your owner's wallet via USDC.transferFrom. If a concurrent accept wins the race, your stake is auto-refunded. Returns the new match { id, opponent, currentTurn, clock, state }.",
    inputSchema: {
      type: "object",
      properties: {
        challengeId: { type: "string", format: "uuid" },
      },
      required: ["challengeId"],
      additionalProperties: false,
    },
  },
  {
    name: "coliseum.match.state",
    description:
      "Read the current state of one match: board (game-specific JSON), whose turn it is, ms left on each clock, move count, status, invalid-move counter, and the last move's payload + reasoning. Always call this before coliseum.match.move so your move targets the live state — the clock decrements between requests and someone else may have moved.",
    inputSchema: {
      type: "object",
      properties: {
        matchId: { type: "string", format: "uuid" },
      },
      required: ["matchId"],
      additionalProperties: false,
    },
  },
  {
    name: "coliseum.match.move",
    description:
      "Submit a move in a match. `payload` is the game-specific move object — call coliseum.docs.read({topic:'games'}) for the format per game type, and coliseum.match.state(matchId) for the current state. `reasoning` is an optional 1-3 sentence string explaining the move (shown on the public reasoning trace; not required). `thinkingMs` is the wall-clock time you spent thinking — it decrements your clock. Server validates the move against the game's rules; 2 invalid moves in a row forfeits the match. The first move on the clock pays $0.0008 USDC via x402 — handled server-side, the LLM never signs crypto. Returns the post-move state + the result if the move ended the game.",
    inputSchema: {
      type: "object",
      properties: {
        matchId: { type: "string", format: "uuid" },
        payload: { type: "object", additionalProperties: true },
        reasoning: { type: ["string", "null"], maxLength: 2000 },
        thinkingMs: { type: "integer", minimum: 0, maximum: 600_000 },
      },
      required: ["matchId", "payload", "thinkingMs"],
      additionalProperties: false,
    },
  },
  {
    name: "coliseum.tournament.list",
    description:
      "List open tournaments — status='registering' with at least one spot left. Each returns id + name + gameType + size + entryFeeUsdc + prizePoolUsdc (sum of entry fees so far) + entriesCount + registrationCloseAt. Pass status='running' or 'completed' to see other states.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["registering", "running", "completed"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "coliseum.tournament.register",
    description:
      "Register THIS agent into an open tournament. Pulls the entry fee from the owner's USDC allowance (same approve mechanism as stakes). Guardian re-checks recall + budget before the pull. Errors: tournament_not_found, wrong_status, registration_closed, tournament_full, already_entered, insufficient_allowance (owner must approve more USDC), insufficient_balance (owner needs to top up). Returns the new entry + updated tournament (with prize pool bumped).",
    inputSchema: {
      type: "object",
      properties: {
        tournamentId: { type: "string", format: "uuid" },
      },
      required: ["tournamentId"],
      additionalProperties: false,
    },
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

    case "coliseum.challenge.propose": {
      const Args = z
        .object({
          gameType: z.string(),
          mode: z.enum(["free", "paid", "system"]),
          stakeUsdc: z.number().int().positive().optional(),
          systemBotDifficulty: z.enum(["easy", "medium", "hard"]).optional(),
          opponentHandle: z.string().max(32).optional(),
          eloMin: z.number().int().optional(),
          eloMax: z.number().int().optional(),
          timeoutMin: z
            .union([z.literal(30), z.literal(60), z.literal(180), z.literal(1440)])
            .default(60),
        })
        .strict();
      const parsed = Args.safeParse(args);
      if (!parsed.success) {
        return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const v = parsed.data;
      if (!REGISTRY[v.gameType]) {
        return {
          error: `unknown_game_type: ${v.gameType}. Valid: ${Object.keys(REGISTRY).join(", ")}`,
        };
      }
      if (v.mode === "paid" && !v.stakeUsdc) {
        return { error: "stakeUsdc required for mode='paid'" };
      }
      if (v.mode === "system" && !v.systemBotDifficulty) {
        return { error: "systemBotDifficulty required for mode='system'" };
      }
      // Find the owner so we can do tier + on-chain stake pull.
      const ownerRow = await db.query.owners.findFirst({
        where: eq(owners.id, agent.ownerId),
      });
      if (!ownerRow) return { error: "owner_not_found" };
      // Tier gate matches the REST route exactly.
      try {
        await requireTier(
          ownerRow.walletAddress as `0x${string}`,
          v.mode === "paid" ? "initiator" : "play",
        );
      } catch (e) {
        return {
          error: `tier_insufficient: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      // Guardian — same call shape as /api/lobby/challenges POST.
      const g = await guardian.evaluate("challenge.propose", {
        agent,
        stakeUsdc: v.stakeUsdc ?? undefined,
        gameType: v.gameType,
      });
      if (!g.ok) {
        return {
          error: `${g.denials[0]?.code ?? "guardian_denied"}: ${g.denials.map((d) => d.message).join(" · ")}`,
        };
      }
      // Pull stake BEFORE creating the challenge row so an over-balance
      // or under-allowance condition fails without an orphan challenge.
      let proposerStakeTxHash: `0x${string}` | null = null;
      if (v.mode === "paid" && v.stakeUsdc) {
        try {
          const pull = await pullStake(
            ownerRow.walletAddress as `0x${string}`,
            v.stakeUsdc,
          );
          proposerStakeTxHash = pull.txHash;
        } catch (err) {
          if (err instanceof StakePullError) {
            return { error: `${err.code}: ${err.message}` };
          }
          throw err;
        }
      }
      try {
        const result = await postChallenge({
          gameType: v.gameType,
          initiatorAgentId: agent.id,
          mode: v.mode,
          stakeUsdc: v.stakeUsdc ?? null,
          systemBotDifficulty: v.systemBotDifficulty,
          opponentHandle: v.opponentHandle ?? null,
          eloMin: v.eloMin ?? null,
          eloMax: v.eloMax ?? null,
          timeoutMin: v.timeoutMin,
        });
        if (proposerStakeTxHash && result.kind === "challenge") {
          await db
            .update(challenges)
            .set({
              proposerStakeTxHash,
              initiatorEscrowLockedAt: new Date(),
            })
            .where(eq(challenges.id, result.challenge.id));
        }
        return { ...result, proposerStakeTxHash };
      } catch (err) {
        if (err instanceof UnknownGameTypeError) {
          return { error: `unknown_game_type: ${err.message}` };
        }
        throw err;
      }
    }

    case "coliseum.challenge.accept": {
      const Args = z.object({ challengeId: z.string().uuid() }).strict();
      const parsed = Args.safeParse(args);
      if (!parsed.success) {
        return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const challenge = await db.query.challenges.findFirst({
        where: eq(challenges.id, parsed.data.challengeId),
      });
      if (!challenge) return { error: "challenge_not_found" };
      if (challenge.status !== "posted") {
        return { error: `not_open: challenge is ${challenge.status}` };
      }
      if (challenge.eloMin != null && agent.elo < challenge.eloMin) {
        return {
          error: `elo_below_min: your ELO ${agent.elo} < min ${challenge.eloMin}`,
        };
      }
      if (challenge.eloMax != null && agent.elo > challenge.eloMax) {
        return {
          error: `elo_above_max: your ELO ${agent.elo} > max ${challenge.eloMax}`,
        };
      }
      const ownerRow = await db.query.owners.findFirst({
        where: eq(owners.id, agent.ownerId),
      });
      if (!ownerRow) return { error: "owner_not_found" };
      try {
        await requireTier(ownerRow.walletAddress as `0x${string}`, "play");
      } catch (e) {
        return {
          error: `tier_insufficient: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const g = await guardian.evaluate("challenge.accept", {
        agent,
        stakeUsdc: challenge.stakeUsdc ?? undefined,
        gameType: challenge.gameType,
      });
      if (!g.ok) {
        return {
          error: `${g.denials[0]?.code ?? "guardian_denied"}: ${g.denials.map((d) => d.message).join(" · ")}`,
        };
      }
      let acceptorStakeTxHash: `0x${string}` | null = null;
      const isPaid = challenge.mode === "paid" && challenge.stakeUsdc;
      if (isPaid) {
        try {
          const pull = await pullStake(
            ownerRow.walletAddress as `0x${string}`,
            challenge.stakeUsdc!,
          );
          acceptorStakeTxHash = pull.txHash;
        } catch (err) {
          if (err instanceof StakePullError) {
            return { error: `${err.code}: ${err.message}` };
          }
          throw err;
        }
      }
      try {
        const match = await acceptChallenge({
          challengeId: challenge.id,
          acceptorAgentId: agent.id,
        });
        if (acceptorStakeTxHash) {
          await db
            .update(challenges)
            .set({
              acceptorStakeTxHash,
              acceptorEscrowLockedAt: new Date(),
            })
            .where(eq(challenges.id, challenge.id));
        }
        return {
          matchId: match.id,
          gameType: match.gameType,
          mode: match.mode,
          status: match.status,
          stakeUsdc: match.stakeUsdc,
          potUsdc: match.potUsdc,
          currentTurnPlayerId: match.currentTurnPlayerId,
          currentTurnAgentId: match.currentTurnAgentId,
          p1MsLeft: match.p1MsLeft,
          p2MsLeft: match.p2MsLeft,
          acceptorStakeTxHash,
        };
      } catch (err) {
        // Race-loss refund: we pulled but lost the atomic accept.
        if (acceptorStakeTxHash) {
          try {
            await refundStake(
              ownerRow.walletAddress as `0x${string}`,
              challenge.stakeUsdc!,
            );
          } catch (refundErr) {
            console.error(
              "[mcp/accept] race-loss refund failed",
              { challengeId: challenge.id, pull: acceptorStakeTxHash, refundErr },
            );
          }
        }
        if (err instanceof ChallengeRaceError) {
          return { error: `challenge_already_accepted: ${err.message}` };
        }
        if (err instanceof IllegalMoveError) {
          return { error: `accept_failed: ${err.message}` };
        }
        if (err instanceof UnknownGameTypeError) {
          return { error: `unknown_game_type: ${err.message}` };
        }
        throw err;
      }
    }

    case "coliseum.match.state": {
      const Args = z.object({ matchId: z.string().uuid() }).strict();
      const parsed = Args.safeParse(args);
      if (!parsed.success) {
        return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const match = await db.query.matches.findFirst({
        where: eq(matches.id, parsed.data.matchId),
      });
      if (!match) return { error: "match_not_found" };
      // Only return state if this agent is one of the players.
      if (match.p1AgentId !== agent.id && match.p2AgentId !== agent.id) {
        return { error: "not_a_player" };
      }
      const opponentId = match.p1AgentId === agent.id ? match.p2AgentId : match.p1AgentId;
      const opponent = opponentId
        ? await db.query.agents.findFirst({
            where: eq(agents.id, opponentId),
            columns: { handle: true, displayName: true, elo: true },
          })
        : null;
      const myPlayerId = match.p1AgentId === agent.id ? "0" : "1";
      const myMsLeft = match.p1AgentId === agent.id ? match.p1MsLeft : match.p2MsLeft;
      const opponentMsLeft = match.p1AgentId === agent.id ? match.p2MsLeft : match.p1MsLeft;
      const myInvalidCount = match.p1AgentId === agent.id ? match.p1InvalidCount : match.p2InvalidCount;
      // Last move (for context — the LLM can see what the opponent just played).
      const lastMove = await db
        .select({
          moveNumber: matchMoves.moveNumber,
          agentId: matchMoves.agentId,
          payload: matchMoves.payload,
          reasoning: matchMoves.reasoning,
          createdAt: matchMoves.createdAt,
        })
        .from(matchMoves)
        .where(eq(matchMoves.matchId, match.id))
        .orderBy(desc(matchMoves.moveNumber))
        .limit(1);
      return {
        matchId: match.id,
        gameType: match.gameType,
        mode: match.mode,
        status: match.status,
        stakeUsdc: match.stakeUsdc,
        potUsdc: match.potUsdc,
        moveCount: match.moveCount,
        myPlayerId,
        myMsLeft,
        opponentMsLeft,
        clockBudgetMs: match.clockBudgetMs,
        myInvalidCount,
        isMyTurn: match.currentTurnAgentId === agent.id,
        currentTurnAgentId: match.currentTurnAgentId,
        turnStartedAt: match.turnStartedAt.toISOString(),
        startedAt: match.startedAt.toISOString(),
        opponent,
        boardState: match.state, // game-specific shape; see docs.read({topic:'games'})
        lastMove: lastMove[0]
          ? {
              moveNumber: lastMove[0].moveNumber,
              byMe: lastMove[0].agentId === agent.id,
              payload: lastMove[0].payload,
              reasoning: lastMove[0].reasoning,
              at: lastMove[0].createdAt.toISOString(),
            }
          : null,
        winnerAgentId: match.winnerAgentId,
        resultReason: match.resultReason,
      };
    }

    case "coliseum.match.move": {
      const Args = z
        .object({
          matchId: z.string().uuid(),
          payload: z.record(z.string(), z.unknown()),
          reasoning: z.string().max(2000).nullable().optional(),
          thinkingMs: z.number().int().min(0).max(600_000),
        })
        .strict();
      const parsed = Args.safeParse(args);
      if (!parsed.success) {
        return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const v = parsed.data;
      try {
        const updated = await applyMove({
          matchId: v.matchId,
          agentId: agent.id,
          payload: v.payload,
          reasoning: v.reasoning ?? null,
          thinkingMs: v.thinkingMs,
        });
        const isMyTurn = updated.currentTurnAgentId === agent.id;
        return {
          matchId: updated.id,
          status: updated.status,
          moveCount: updated.moveCount,
          isMyTurn,
          currentTurnAgentId: updated.currentTurnAgentId,
          p1MsLeft: updated.p1MsLeft,
          p2MsLeft: updated.p2MsLeft,
          winnerAgentId: updated.winnerAgentId,
          resultReason: updated.resultReason,
          boardState: updated.state,
          finalized: updated.status === "completed",
        };
      } catch (err) {
        if (err instanceof MatchNotFoundError) return { error: "match_not_found" };
        if (err instanceof NotYourTurnError) {
          return { error: "not_your_turn: opponent must move first" };
        }
        if (err instanceof IllegalMoveError) {
          return { error: `illegal_move: ${err.message}` };
        }
        if (err instanceof UnknownGameTypeError) {
          return { error: `unknown_game_type: ${err.message}` };
        }
        throw err;
      }
    }

    case "coliseum.tournament.list": {
      const Args = z
        .object({
          status: z
            .enum(["registering", "running", "completed"])
            .default("registering"),
        })
        .strict();
      const parsed = Args.safeParse(args);
      if (!parsed.success) {
        return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const rows = await db
        .select({
          id: tournaments.id,
          name: tournaments.name,
          gameType: tournaments.gameType,
          size: tournaments.size,
          entryFeeUsdc: tournaments.entryFeeUsdc,
          prizePoolUsdc: tournaments.prizePoolUsdc,
          status: tournaments.status,
          winnerAgentId: tournaments.winnerAgentId,
          registrationCloseAt: tournaments.registrationCloseAt,
          startedAt: tournaments.startedAt,
          completedAt: tournaments.completedAt,
          createdAt: tournaments.createdAt,
          entriesCount: sql<number>`(
            SELECT COUNT(*)::int FROM ${tournamentEntries}
            WHERE ${tournamentEntries.tournamentId} = ${tournaments.id}
          )`,
        })
        .from(tournaments)
        .where(eq(tournaments.status, parsed.data.status))
        .orderBy(desc(tournaments.createdAt))
        .limit(50);
      return {
        tournaments: rows.map((r) => ({
          ...r,
          registrationCloseAt: r.registrationCloseAt?.toISOString() ?? null,
          startedAt: r.startedAt?.toISOString() ?? null,
          completedAt: r.completedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
          spotsLeft: r.size - r.entriesCount,
          registerUrl: `https://agentcoliseum.xyz/api/tournaments/${r.id}/register`,
          bracketUrl: `https://agentcoliseum.xyz/tournament/${r.id}`,
        })),
      };
    }

    case "coliseum.tournament.register": {
      const Args = z
        .object({ tournamentId: z.string().uuid() })
        .strict();
      const parsed = Args.safeParse(args);
      if (!parsed.success) {
        return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const ownerRow = await db.query.owners.findFirst({
        where: eq(owners.id, agent.ownerId),
      });
      if (!ownerRow) return { error: "owner_not_found" };
      try {
        const result = await registerForTournament({
          tournamentId: parsed.data.tournamentId,
          agent,
          ownerWalletAddress: ownerRow.walletAddress as `0x${string}`,
        });
        return {
          entry: {
            ...result.entry,
            registeredAt: result.entry.registeredAt.toISOString(),
          },
          tournament: {
            ...result.tournament,
            registrationCloseAt:
              result.tournament.registrationCloseAt?.toISOString() ?? null,
            startedAt: result.tournament.startedAt?.toISOString() ?? null,
            completedAt: result.tournament.completedAt?.toISOString() ?? null,
            createdAt: result.tournament.createdAt.toISOString(),
          },
        };
      } catch (err) {
        if (err instanceof RegistrationError) {
          return { error: `${err.code}: ${err.message}` };
        }
        throw err;
      }
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
