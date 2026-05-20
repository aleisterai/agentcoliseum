/**
 * Shared registration logic — called by BOTH the owner-Privy route
 * (POST /api/tournaments/[id]/register) AND the MCP tool
 * (coliseum_tournament_register). One source of truth so the two
 * paths can't drift in their Guardian / stake-pull / DB semantics.
 *
 * Caller resolves the auth (Privy session OR MCP bearer) and provides
 * the agent + owner that are entering. This helper:
 *   1. Validates the tournament is in 'registering' state + has room.
 *   2. Rejects double-entry.
 *   3. Runs the Guardian (force-recall + budget caps).
 *   4. Pulls the entry fee on-chain (if > 0).
 *   5. Inserts the entry + bumps prize pool atomically.
 *
 * Returns the new entry + updated tournament. Throws RegistrationError
 * with a machine-parseable code on rejection; the caller maps that to
 * the right transport error (HTTP status code or JSON-RPC error
 * string).
 */
import "server-only";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  tournaments,
  tournamentEntries,
  type Agent,
} from "@/lib/db/schema";
import { guardian } from "@/lib/guardian";
import { pullStake, StakePullError } from "@/lib/chain/stake";

export type RegistrationErrorCode =
  | "tournament_not_found"
  | "wrong_status"
  | "registration_closed"
  | "tournament_full"
  | "already_entered"
  | "guardian_denied"
  | "insufficient_allowance"
  | "insufficient_balance"
  | "transferFrom_reverted"
  | "rpc_error"
  | "internal";

export class RegistrationError extends Error {
  constructor(
    public readonly code: RegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

export interface RegistrationResult {
  entry: typeof tournamentEntries.$inferSelect;
  tournament: typeof tournaments.$inferSelect;
}

export async function registerForTournament(args: {
  tournamentId: string;
  agent: Agent;
  ownerWalletAddress: `0x${string}`;
}): Promise<RegistrationResult> {
  const { tournamentId, agent, ownerWalletAddress } = args;

  const tournament = await db.query.tournaments.findFirst({
    where: eq(tournaments.id, tournamentId),
  });
  if (!tournament) {
    throw new RegistrationError("tournament_not_found", "No such tournament");
  }
  if (tournament.status !== "registering") {
    throw new RegistrationError(
      "wrong_status",
      `Tournament is ${tournament.status} (must be 'registering' to enter)`,
    );
  }
  if (
    tournament.registrationCloseAt &&
    tournament.registrationCloseAt.getTime() < Date.now()
  ) {
    throw new RegistrationError(
      "registration_closed",
      "Registration window has closed",
    );
  }
  const [{ c: filled }] = await db
    .select({ c: count() })
    .from(tournamentEntries)
    .where(eq(tournamentEntries.tournamentId, tournament.id));
  if (filled >= tournament.size) {
    throw new RegistrationError(
      "tournament_full",
      `Tournament is already full (${filled}/${tournament.size})`,
    );
  }

  const existing = await db.query.tournamentEntries.findFirst({
    where: and(
      eq(tournamentEntries.tournamentId, tournament.id),
      eq(tournamentEntries.agentId, agent.id),
    ),
  });
  if (existing) {
    throw new RegistrationError(
      "already_entered",
      "This agent is already entered in this tournament",
    );
  }

  // Guardian — same checks as challenge.propose since the entry fee is
  // real money out of the owner's wallet.
  const guard = await guardian.evaluate("challenge.propose", {
    agent,
    stakeUsdc: tournament.entryFeeUsdc || undefined,
    gameType: tournament.gameType,
  });
  if (!guard.ok) {
    throw new RegistrationError(
      "guardian_denied",
      guard.denials.map((d) => `${d.code}: ${d.message}`).join(" · "),
    );
  }

  // Pull entry fee. Zero-fee tournaments skip the pull.
  let entryFeeTxHash: `0x${string}` | null = null;
  if (tournament.entryFeeUsdc > 0) {
    try {
      const pull = await pullStake(ownerWalletAddress, tournament.entryFeeUsdc);
      entryFeeTxHash = pull.txHash;
    } catch (err) {
      if (err instanceof StakePullError) {
        throw new RegistrationError(err.code, err.message);
      }
      throw new RegistrationError(
        "internal",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Insert entry + bump prize pool atomically.
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(tournamentEntries)
      .values({
        tournamentId: tournament.id,
        agentId: agent.id,
        entryFeeTxHash,
      })
      .returning();
    const [updated] = await tx
      .update(tournaments)
      .set({
        prizePoolUsdc: tournament.prizePoolUsdc + tournament.entryFeeUsdc,
      })
      .where(eq(tournaments.id, tournament.id))
      .returning();
    return { entry, tournament: updated };
  });
}
