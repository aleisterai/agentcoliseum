/**
 * Cached tier lookup. Server-side only.
 *
 * Reads `tier_cache` first; if the row is fresh (< 60s), returns it.
 * Otherwise falls through to a live RPC read, persists, and returns.
 *
 * Caller is responsible for not exposing this on the client (network roundtrip
 * + DB write — keep it inside API route handlers and server components).
 */
import "server-only";
import { eq } from "drizzle-orm";
import { getAddress, type Address } from "viem";
import { db } from "@/lib/db/client";
import { tierCache } from "@/lib/db/schema";
import { getTier, type Tier } from "./aleister";

const TTL_MS = 60_000;

export type TierResult = {
  wallet: Address;
  tier: Tier;
  balanceWei: bigint;
  cachedAt: Date;
  fromCache: boolean;
};

/** Look up a wallet's tier, using the 60-second cache when fresh. */
export async function lookupTier(wallet: Address): Promise<TierResult> {
  const checksummed = getAddress(wallet);

  // 1. Check cache.
  const cached = await db.query.tierCache.findFirst({
    where: eq(tierCache.walletAddress, checksummed),
  });
  if (cached && Date.now() - cached.cachedAt.getTime() < TTL_MS) {
    return {
      wallet: checksummed,
      tier: cached.tier as Tier,
      balanceWei: BigInt(cached.balanceWei),
      cachedAt: cached.cachedAt,
      fromCache: true,
    };
  }

  // 2. Cache miss / stale — fetch live and persist.
  const { balanceWei, tier } = await getTier(checksummed);
  const now = new Date();
  await db
    .insert(tierCache)
    .values({
      walletAddress: checksummed,
      balanceWei: balanceWei.toString(),
      tier,
      cachedAt: now,
    })
    .onConflictDoUpdate({
      target: tierCache.walletAddress,
      set: {
        balanceWei: balanceWei.toString(),
        tier,
        cachedAt: now,
      },
    });

  return {
    wallet: checksummed,
    tier,
    balanceWei,
    cachedAt: now,
    fromCache: false,
  };
}

/** Hard tier-gate for API routes. Throws a typed error if the wallet is under-tier. */
export async function requireTier(
  wallet: Address,
  min: Tier,
): Promise<TierResult> {
  const result = await lookupTier(wallet);
  if (!atLeast(result.tier, min)) {
    throw new TierInsufficientError(min, result.tier);
  }
  return result;
}

export function atLeast(have: Tier, need: Tier): boolean {
  const order: Record<Tier, number> = { none: 0, play: 1, initiator: 2 };
  return order[have] >= order[need];
}

export class TierInsufficientError extends Error {
  readonly required: Tier;
  readonly actual: Tier;
  constructor(required: Tier, actual: Tier) {
    super(`Insufficient tier: have ${actual}, need ${required}`);
    this.name = "TierInsufficientError";
    this.required = required;
    this.actual = actual;
  }
}

// ── requirePlayAccess — the autonomous-onboarding tier gate ──────────
//
// New in 2026-05. Replaces / supplements `requireTier` for the
// per-action paid-play gate on the new two-tier onboarding model
// (autonomous agents register via `npx @agentcoliseum/init`, link a
// wallet via the wallet_connect MCP tool, then pay games are gated on
// that wallet's live $ALEISTER balance + the agent's paid-games
// counter).
//
// The rule:
//   - no linked wallet              → can_play=false, code='no_wallet_linked'
//   - balance < 20M $ALEISTER       → can_play=false, code='tier_below_play'
//   - balance ≥ 20M, gamesPlayed<5  → can_play=true,  tier='play'
//   - balance ≥ 20M, gamesPlayed≥5  → can_play=false, code='tier_below_initiator'
//   - balance ≥ 50M                 → can_play=true,  tier='initiator'
//
// Both balance AND counter are evaluated independently. A Play-tier
// agent that hits the 5-game cap must upgrade their wallet to 50M+
// to continue. Selling the wallet down to <20M revokes paid access
// regardless of how many games they've played.
//
// Returns a tagged union (NOT throwing) because the caller almost
// always wants to translate the result into a structured tool error.
// Throwing would force every caller to wrap in try/catch.

export interface PlayAccessOk {
  ok: true;
  tier: "play" | "initiator";
  balanceWei: bigint;
  balanceFormatted: string; // human-readable, e.g. "25.0M"
  wallet: Address;
  paidGamesPlayed: number;
  paidGamesRemaining: number | null; // null = unlimited (initiator)
  fromCache: boolean;
  cachedAt: Date;
}

export interface PlayAccessDenied {
  ok: false;
  code:
    | "no_wallet_linked"
    | "tier_below_play"
    | "tier_below_initiator"
    | "wallet_invalid";
  message: string;
  details: Record<string, unknown>;
  hint: string;
}

export type PlayAccessResult = PlayAccessOk | PlayAccessDenied;

/** Threshold the Play tier unlocks (used for the 5-game cap before
 *  Initiator becomes required). Exposed so tests + tools can show
 *  consistent numbers. */
export const PLAY_TIER_GAME_CAP = 5;

/** Read-only agent shape this helper consumes. We don't accept the
 *  whole Agent row because that drags in jsonb fields the tier check
 *  doesn't need and forces consumers to do an extra select. */
export interface PlayAccessAgent {
  id: string;
  handle: string;
  linkedWalletAddress: string | null;
  paidGamesPlayed: number;
}

/**
 * The autonomous-onboarding tier gate. Called by the MCP dispatcher
 * (or directly by tool handlers) before any paid-play action.
 *
 * Result is structured so consumers can build a unified ToolError
 * envelope without inspecting messages:
 *
 *   const res = await requirePlayAccess(agent);
 *   if (!res.ok) return toolError(res.code, res.message, {
 *     details: res.details, hint: res.hint
 *   });
 *
 * Uses the existing tier_cache (60s TTL) — same cache row a Privy
 * owner-mediated tier check would populate. The two paths share
 * infrastructure transparently.
 */
export async function requirePlayAccess(
  agent: PlayAccessAgent,
): Promise<PlayAccessResult> {
  // 1. Must have a wallet linked. Free-tier agents fail here.
  if (!agent.linkedWalletAddress) {
    return {
      ok: false,
      code: "no_wallet_linked",
      message:
        "this agent has no linked wallet; paid play requires linking a wallet that holds ≥20M $ALEISTER",
      details: {
        agentId: agent.id,
        handle: agent.handle,
        playThresholdAleister: "20M",
        initiatorThresholdAleister: "50M",
        aleisterAddress: "0xacb4543f479ea44e6df4fa01e483bb5b78361ba3",
      },
      hint: "Call coliseum_agent_wallet_link_request → sign the message with a wallet holding ≥20M $ALEISTER → coliseum_agent_wallet_connect. The wallet stays in your control — Coliseum just reads its balance.",
    };
  }

  // 2. Validate the wallet format. A bad checksum means the link tool
  //    accepted garbage; defence-in-depth.
  let checksummed: Address;
  try {
    checksummed = getAddress(agent.linkedWalletAddress);
  } catch {
    return {
      ok: false,
      code: "wallet_invalid",
      message: `linked wallet "${agent.linkedWalletAddress}" is not a valid address`,
      details: { rawWallet: agent.linkedWalletAddress },
      hint: "Re-link the wallet via coliseum_agent_wallet_link_request. This should not happen — file a bug if it persists.",
    };
  }

  // 3. Read the wallet's live balance (cached 60s).
  const result = await lookupTier(checksummed);
  const balanceFormatted = formatAleisterBalance(result.balanceWei);

  // 4. Balance gate: below Play threshold → reject.
  if (result.tier === "none") {
    return {
      ok: false,
      code: "tier_below_play",
      message: `linked wallet holds ${balanceFormatted} $ALEISTER, below the ${"20M"} Play tier`,
      details: {
        wallet: checksummed,
        balanceWei: result.balanceWei.toString(),
        balanceFormatted,
        playThresholdAleister: "20M",
        initiatorThresholdAleister: "50M",
        balanceCachedAt: result.cachedAt.toISOString(),
        balanceFromCache: result.fromCache,
      },
      hint: "Top up the linked wallet with $ALEISTER (CA: 0xacb4543f479ea44e6df4fa01e483bb5b78361ba3 on Base, e.g. via Aerodrome) OR link a different wallet that meets the threshold via coliseum_agent_wallet_disconnect → coliseum_agent_wallet_link_request → coliseum_agent_wallet_connect.",
    };
  }

  // 5. Counter gate: Play tier exhausts at PLAY_TIER_GAME_CAP paid games.
  if (result.tier === "play" && agent.paidGamesPlayed >= PLAY_TIER_GAME_CAP) {
    return {
      ok: false,
      code: "tier_below_initiator",
      message: `linked wallet holds ${balanceFormatted} $ALEISTER (Play tier), but this agent has already played ${agent.paidGamesPlayed} paid games — the Play tier 5-game cap is exhausted`,
      details: {
        wallet: checksummed,
        balanceWei: result.balanceWei.toString(),
        balanceFormatted,
        paidGamesPlayed: agent.paidGamesPlayed,
        playGameCap: PLAY_TIER_GAME_CAP,
        initiatorThresholdAleister: "50M",
        balanceCachedAt: result.cachedAt.toISOString(),
        balanceFromCache: result.fromCache,
      },
      hint: "Top up the linked wallet to ≥50M $ALEISTER for the Initiator tier (unlimited paid games). The 5-game counter is sticky to the agent — disconnecting + reconnecting a fresh wallet won't reset it.",
    };
  }

  // 6. OK. Return the rich result so callers can surface tier info on success.
  return {
    ok: true,
    tier: result.tier,
    balanceWei: result.balanceWei,
    balanceFormatted,
    wallet: checksummed,
    paidGamesPlayed: agent.paidGamesPlayed,
    paidGamesRemaining:
      result.tier === "initiator"
        ? null
        : Math.max(0, PLAY_TIER_GAME_CAP - agent.paidGamesPlayed),
    fromCache: result.fromCache,
    cachedAt: result.cachedAt,
  };
}

/** Format a wei balance into a short human string ("25.0M", "1.2B").
 *  Used in error details + tier_status output. */
export function formatAleisterBalance(wei: bigint): string {
  const decimals = 18n;
  const whole = wei / 10n ** decimals;
  const m = Number(whole) / 1_000_000;
  if (m >= 1_000) return `${(m / 1_000).toFixed(1)}B`;
  if (m >= 1) return `${m.toFixed(1)}M`;
  const k = Number(whole) / 1_000;
  if (k >= 1) return `${k.toFixed(1)}K`;
  return `${whole.toString()}`;
}
