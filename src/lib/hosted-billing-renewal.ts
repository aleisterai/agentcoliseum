/**
 * Hosted-billing renewal claim — the idempotency guard that prevents
 * double-charging an owner's $20 monthly fee.
 *
 * The problem it solves:
 *   The hosted-billing cron pulls $20 USDC on-chain BEFORE writing the
 *   renewal row to the DB. If the function crashes / times out (Vercel
 *   maxDuration) after the transfer mines but before the DB commit, the
 *   subscription row is unchanged (still status='active', still inside
 *   the 24h billing window). Tomorrow's run re-selects it and pulls $20
 *   a SECOND time. The owner is billed twice for one period.
 *
 * The fix:
 *   Before pulling payment, atomically flip the row 'active' → 'renewing'
 *   with a compare-and-swap. The billing cron's selection query filters
 *   status='active', so a 'renewing' row is invisible to any retry — the
 *   second pull can never happen.
 *
 * Failure analysis after this change:
 *   - crash AFTER claim, BEFORE pull        → row stuck 'renewing', no
 *                                              charge happened, recoverable
 *                                              (operator re-activates).
 *   - crash AFTER pull, BEFORE finalize     → row stuck 'renewing', charged
 *                                              once, sub lapses. Under-
 *                                              delivery (paid, not credited)
 *                                              — recoverable, and crucially
 *                                              NEVER a double-charge.
 *   Both failure modes are strictly safer than the double-charge they
 *   replace: we trade "take the user's money twice" for "rare, operator-
 *   recoverable under-charge."
 */
import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hostedAgentSubscriptions } from "@/lib/db/schema";

/**
 * Compare-and-swap claim. Returns true if THIS caller won the claim
 * (the row was 'active' and is now 'renewing' — safe to pull payment),
 * false if the row was already claimed/handled by a concurrent or prior
 * run (do NOT pull payment).
 *
 * `status` is a plain text column, so 'renewing' needs no enum migration.
 * It's a transient state held only for the seconds between claim and
 * finalize; the dashboard + enable/disable flows all key off 'active'.
 */
export async function claimSubscriptionForRenewal(
  subscriptionId: string,
): Promise<boolean> {
  const claimed = await db
    .update(hostedAgentSubscriptions)
    .set({ status: "renewing" })
    .where(
      and(
        eq(hostedAgentSubscriptions.id, subscriptionId),
        eq(hostedAgentSubscriptions.status, "active"),
      ),
    )
    .returning({ id: hostedAgentSubscriptions.id });
  return claimed.length === 1;
}
