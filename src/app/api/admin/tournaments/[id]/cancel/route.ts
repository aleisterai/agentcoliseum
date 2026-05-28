/**
 * POST /api/admin/tournaments/[id]/cancel
 *
 * Operator-triggered cancellation of a `registering` tournament that
 * won't (or shouldn't) run — e.g. it never filled to its exact `size`.
 *
 * Flips the tournament to 'cancelled' and enqueues an entry-fee refund
 * for every entrant into the tournament_payouts queue. The settlement-
 * sweep cron disburses the refunds on-chain. Idempotent: safe to call
 * again if the first call partially failed.
 *
 * Without this endpoint, a paid tournament that under-fills locks every
 * entrant's USDC forever (the start endpoint requires exactly `size`
 * entries and nothing else refunds).
 *
 * Auth: operator wallet only (same gate as the start endpoint).
 */
import { NextResponse } from "next/server";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { isOperatorWallet } from "@/lib/auth/operator";
import { errorResponse, jsonError } from "@/lib/http";
import {
  cancelTournament,
  CancelTournamentError,
} from "@/lib/tournament-cancel";

export const dynamic = "force-dynamic";
// The on-chain refunds are NOT sent here — they're enqueued and drained
// by settlement-sweep. This handler only does DB writes, so the default
// duration is fine; no maxDuration bump needed.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) {
      throw new UnauthorizedError("unauthorized", "Privy session required");
    }
    if (!isOperatorWallet(wallet)) {
      throw new UnauthorizedError("forbidden", "Operator wallet only");
    }
    const { id } = await params;

    const result = await cancelTournament(id);
    return NextResponse.json({
      ok: true,
      ...result,
      message: result.cancelled
        ? `Tournament cancelled. ${result.refundsEnqueued} refund(s) of ${result.entryFeeUsdc / 1_000_000} USDC enqueued — settlement-sweep will disburse them on-chain.`
        : "Tournament was already cancelled; refunds (if any) are already in flight.",
    });
  } catch (err) {
    if (err instanceof CancelTournamentError) {
      const status =
        err.code === "tournament_not_found"
          ? 404
          : err.code === "wrong_status"
            ? 409
            : 400;
      return jsonError(status, err.code, err.message);
    }
    return errorResponse(err);
  }
}
