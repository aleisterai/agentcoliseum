/**
 * Server-side auth helpers.
 *
 * Two distinct auth modes:
 *
 *   1. **API key (agents)** — `Authorization: Bearer ack_xxx` issued by
 *      `/api/owners/me`. Resolves to an owner row, and (if used by an agent)
 *      to a specific agent row. Used for all agent-driven endpoints.
 *
 *   2. **Privy session (humans)** — Privy-issued JWT, validated against the
 *      Privy app's JWKS. Used for the owner-onboarding endpoint that mints
 *      API keys, and for the dashboard. The verified user is mapped to a
 *      wallet via Privy's user record.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, owners, type Agent, type Owner } from "@/lib/db/schema";

export class UnauthorizedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UnauthorizedError";
    this.code = code;
  }
}

const KEY_PREFIX = "ack_"; // "Agent Coliseum Key"

/** Cryptographically random API key. 32-byte secret → 256 bits of entropy. */
export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** Pull the `Bearer` token from an Authorization header. */
function bearerFrom(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const [scheme, token] = h.split(" ", 2);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

/**
 * Auth as an owner via API key. Agents acting on behalf of their owner
 * present the owner's key. We return the owner row.
 */
export async function requireOwnerByApiKey(req: Request): Promise<Owner> {
  const token = bearerFrom(req);
  if (!token) throw new UnauthorizedError("unauthorized", "Missing Bearer token");
  const row = await db.query.owners.findFirst({ where: eq(owners.apiKey, token) });
  if (!row) throw new UnauthorizedError("unauthorized", "API key not recognized");
  // Touch lastSeenAt for an audit trail.
  await db.update(owners).set({ lastSeenAt: new Date() }).where(eq(owners.id, row.id));
  return row;
}

/**
 * Same as requireOwnerByApiKey, but also resolves a specific `agentHandle` and
 * verifies it belongs to the authenticated owner. Used by the move endpoint
 * (where the body or path identifies the agent).
 */
export async function requireAgentByApiKey(
  req: Request,
  predicate: (agent: Agent) => boolean = () => true,
): Promise<{ owner: Owner; agent: Agent }> {
  const owner = await requireOwnerByApiKey(req);
  // For now: assume one agent per owner is the typical case. If the predicate
  // matches multiple, we return the first; refine when multi-agent flow lands.
  const ownerAgents = await db.query.agents.findMany({ where: eq(agents.ownerId, owner.id) });
  const agent = ownerAgents.find(predicate);
  if (!agent) {
    throw new UnauthorizedError(
      "no_agent",
      "Authenticated owner has no agent matching this request",
    );
  }
  return { owner, agent };
}

/**
 * Resolve a Privy access token to the verified identity: the user's primary
 * EVM wallet address + their Privy user id. The user id lets callers
 * back-fill `owners.privy_user_id` on a row that was first created via the
 * MCP wallet-link flow (which only knew the wallet).
 *
 * Returns null if no valid Privy token is present.
 */
export async function resolvePrivyIdentity(
  req: Request,
): Promise<{ wallet: `0x${string}`; privyUserId: string } | null> {
  const token = bearerFrom(req);
  if (!token) return null;
  // Lazy import — keeps the privy SDK out of the cold path for non-Privy routes.
  const { PrivyClient } = await import("@privy-io/server-auth");
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new UnauthorizedError("misconfigured", "Privy server credentials missing");
  }
  const privy = new PrivyClient(appId, appSecret);
  try {
    const claims = await privy.verifyAuthToken(token);
    const user = await privy.getUser(claims.userId);
    // Pick the user's primary EVM wallet.
    const wallet = user.linkedAccounts?.find(
      (a) => a.type === "wallet" && (a as { chainType?: string }).chainType !== "solana",
    ) as { address?: string } | undefined;
    if (!wallet?.address) return null;
    return {
      wallet: wallet.address.toLowerCase() as `0x${string}`,
      privyUserId: claims.userId,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a Privy access token to a wallet address. Thin wrapper over
 * `resolvePrivyIdentity` kept for the many callers that only need the wallet.
 */
export async function resolvePrivyWallet(req: Request): Promise<`0x${string}` | null> {
  return (await resolvePrivyIdentity(req))?.wallet ?? null;
}
