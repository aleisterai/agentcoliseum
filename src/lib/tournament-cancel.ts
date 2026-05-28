/**
 * Tournament cancellation + entry-fee refund.
 *
 * The gap this closes (P0 money-stranding):
 *   Entry fees are pulled on-chain at registration into the operator
 *   wallet (see tournament-registration.ts). The start endpoint requires
 *   EXACTLY `size` entries, and nothing ever refunds. So a paid tournament
 *   that never fills to its exact size locks every entrant's USDC forever.
 *
 * The fix:
 *   `cancelTournament` flips the tournament to 'cancelled' and enqueues a
 *   refund into the SAME idempotent `tournament_payouts` queue that prize
 *   payouts use. The settlement-sweep cron then disburses each refund
 *   on-chain (submit → wait → confirm), exactly like a prize payout. The
 *   queue's UNIQUE(tournamentId, recipientAddress) index makes the whole
 *   operation idempotent — calling cancelTournament twice (or a crash +
 *   retry) can never enqueue a second refund for the same entrant.
 *
 * Only `registering` tournaments can be cancelled here. A `running`
 * tournament has live matches + a half-built bracket; tearing that down
 * is a separate, riskier operation we deliberately don't expose. A
 * `completed`/`paying_out` tournament already paid its winner. Calling
 * this on an already-`cancelled` tournament is a no-op (idempotent).
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  agents,
  owners,
  tournaments,
  tournamentEntries,
  tournamentPayouts,
} from "@/lib/db/schema";

export type CancelTournamentErrorCode =
  | "tournament_not_found"
  | "wrong_status"
  | "unresolved_recipient";

export class CancelTournamentError extends Error {
  constructor(
    public readonly code: CancelTournamentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CancelTournamentError";
  }
}

export interface CancelTournamentResult {
  tournamentId: string;
  /** true if this call performed the cancel; false if it was already cancelled. */
  cancelled: boolean;
  /** Number of refund rows enqueued (0 for free tournaments / repeat calls). */
  refundsEnqueued: number;
  entryFeeUsdc: number;
}

/**
 * Cancel a `registering` tournament and enqueue entry-fee refunds.
 * Idempotent: safe to call repeatedly.
 */
export async function cancelTournament(
  tournamentId: string,
): Promise<CancelTournamentResult> {
  const tournament = await db.query.tournaments.findFirst({
    where: eq(tournaments.id, tournamentId),
  });
  if (!tournament) {
    throw new CancelTournamentError(
      "tournament_not_found",
      "No such tournament",
    );
  }

  // Idempotent: already cancelled → nothing to do. The refund rows (if
  // any) were enqueued on the first call and are being drained by
  // settlement-sweep.
  if (tournament.status === "cancelled") {
    return {
      tournamentId,
      cancelled: false,
      refundsEnqueued: 0,
      entryFeeUsdc: tournament.entryFeeUsdc,
    };
  }
  if (tournament.status !== "registering") {
    throw new CancelTournamentError(
      "wrong_status",
      `Tournament is '${tournament.status}'. Only 'registering' tournaments can be cancelled + refunded here.`,
    );
  }

  // Resolve each entrant's refund recipient: the owner wallet the entry
  // fee was pulled from. Join entries → agents → owners. We snapshot the
  // address into tournament_payouts (owner may rotate wallets later).
  const rows = await db
    .select({
      agentId: tournamentEntries.agentId,
      linkedWallet: agents.linkedWalletAddress,
      ownerWallet: owners.walletAddress,
    })
    .from(tournamentEntries)
    .leftJoin(agents, eq(agents.id, tournamentEntries.agentId))
    .leftJoin(owners, eq(owners.id, agents.ownerId))
    .where(eq(tournamentEntries.tournamentId, tournamentId));

  // Only paid tournaments refund. Free tournaments (entryFee 0) just flip
  // status — there's no money to return.
  const refunds: Array<{ agentId: string; recipient: string }> = [];
  if (tournament.entryFeeUsdc > 0) {
    const unresolved: string[] = [];
    for (const r of rows) {
      const recipient = r.linkedWallet ?? r.ownerWallet;
      if (!recipient) {
        unresolved.push(r.agentId);
        continue;
      }
      refunds.push({ agentId: r.agentId, recipient });
    }
    // Fail BEFORE any write if a paid entrant has no resolvable wallet —
    // a partial cancel would strand their fee. Operator fixes the wallet
    // linkage and retries (cancel is idempotent).
    if (unresolved.length > 0) {
      throw new CancelTournamentError(
        "unresolved_recipient",
        `Cannot resolve a refund wallet for agent(s): ${unresolved.join(", ")}. Aborting so no entrant is stranded.`,
      );
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(tournaments)
      .set({ status: "cancelled" })
      .where(eq(tournaments.id, tournamentId));

    for (const refund of refunds) {
      // onConflictDoNothing against UNIQUE(tournamentId, recipientAddress)
      // → idempotent. A repeat call or a crash-retry never double-refunds.
      await tx
        .insert(tournamentPayouts)
        .values({
          tournamentId,
          recipientAddress: refund.recipient,
          recipientAgentId: refund.agentId,
          amountUsdc: tournament.entryFeeUsdc,
          status: "pending",
        })
        .onConflictDoNothing({
          target: [
            tournamentPayouts.tournamentId,
            tournamentPayouts.recipientAddress,
          ],
        });
    }
  });

  return {
    tournamentId,
    cancelled: true,
    refundsEnqueued: refunds.length,
    entryFeeUsdc: tournament.entryFeeUsdc,
  };
}
