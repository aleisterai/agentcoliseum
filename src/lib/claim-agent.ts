/**
 * Claim an orphan (ownerless) agent into a human owner account.
 *
 * Background: `npx @agentcoliseum/init` registers an agent with
 * `owner_id = NULL` (PoW only, no Privy account). Such an agent plays
 * free-mode fine, but no human can see it in the dashboard or manage it
 * (every owner route filters `WHERE owner_id = me`). Two adoption paths:
 *
 *   1. Wallet match (automatic): the agent links a wallet via MCP, which
 *      find-or-creates an owner keyed by that wallet AND sets owner_id. The
 *      human then signs into the dashboard with that same wallet and the
 *      agent is already theirs. No claim needed.
 *
 *   2. Credential claim (this function): for agents that never linked a
 *      wallet. The human pastes the agent's `ack_` credential in the
 *      dashboard; we bind it to their owner row — but ONLY if it's still
 *      unowned. Holding the credential is the proof of control.
 *
 * Pure DB logic, no auth — the route resolves the owner first, then calls
 * this. Unit-tested against the pglite harness.
 */
import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents } from "@/lib/db/schema";

export type ClaimResult =
  | { status: "claimed"; handle: string; displayName: string }
  | { status: "already_yours"; handle: string; displayName: string }
  | { status: "already_claimed" }
  | { status: "invalid_credential" };

export async function claimOrphanAgent(input: {
  ownerId: string;
  credential: string;
}): Promise<ClaimResult> {
  const credential = input.credential.trim();
  if (!credential) return { status: "invalid_credential" };

  // The pasted `ack_` is stored plaintext as agents.api_key (same lookup
  // the MCP bearer auth uses).
  const agent = await db.query.agents.findFirst({
    where: eq(agents.apiKey, credential),
  });
  if (!agent) return { status: "invalid_credential" };

  if (agent.ownerId === input.ownerId) {
    return {
      status: "already_yours",
      handle: agent.handle,
      displayName: agent.displayName,
    };
  }
  // Owned by someone else — never reassign. (To move an agent between
  // accounts, the controller signs in with its linked wallet.)
  if (agent.ownerId !== null) return { status: "already_claimed" };

  // Bind, race-safe: the WHERE re-asserts owner_id IS NULL so two
  // concurrent claims can't both win.
  const [updated] = await db
    .update(agents)
    .set({ ownerId: input.ownerId })
    .where(and(eq(agents.id, agent.id), isNull(agents.ownerId)))
    .returning({ handle: agents.handle, displayName: agents.displayName });

  if (!updated) return { status: "already_claimed" }; // lost the race
  return {
    status: "claimed",
    handle: updated.handle,
    displayName: updated.displayName,
  };
}
