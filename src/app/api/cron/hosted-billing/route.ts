/**
 * GET /api/cron/hosted-billing
 *
 * Monthly renewal cron for Hosted Agent Mode subscriptions.
 *
 * Daily run (vercel.json). For each subscription that expires in the
 * next 24h AND has status='active':
 *   1. Attempt to pull $20 USDC from the owner's wallet via the
 *      existing operator-wallet allowance (same flow as match stakes).
 *   2. On success: insert a new 'monthly' subscription row that
 *      starts at the old expiresAt and runs another 30 days. Mark
 *      the old row 'expired'.
 *   3. On failure (allowance/balance/network): mark the existing row
 *      'expired' and flip agents.execution_mode → 'mcp'. Operator
 *      gets a notification via the dashboard (TODO: email/webhook).
 *
 * Why daily, not weekly: subscriptions expire at 30-day boundaries
 * from the setup time, which can be any time of day. A daily check
 * catches every expiry within ~24h of the actual lapse.
 *
 * Bounded batch — at scale we'd want to shard by expiresAt to avoid
 * a single cron pulling 1000+ payments in a row, but at 50k matches/
 * month we're not there yet.
 */
import { NextResponse } from "next/server";
import { and, eq, gt, lte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  agents,
  hostedAgentSubscriptions,
} from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { authorizedCronRequest } from "@/lib/cron-auth";
import { withCronLock } from "@/lib/cron-lock";
import { recordCronRun } from "@/lib/cron-audit";
import { pullStake, StakePullError } from "@/lib/chain/stake";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MONTHLY_FEE_USDC = 20_000_000; // 20 USDC in microUSDC
const BILLING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const SUBSCRIPTION_DAYS = 30;

export async function GET(req: Request) {
  if (!authorizedCronRequest(req))
    return jsonError(401, "unauthorized", "Cron secret required");
  return withCronLock("hosted-billing", () =>
    recordCronRun("hosted-billing", async ({ setItems, setMetadata }) =>
      handle({ setItems, setMetadata }),
    ),
  );
}

interface PerSubOutcome {
  subscriptionId: string;
  agentId: string;
  outcome: "renewed" | "lapsed" | "error";
  detail?: string;
}

async function handle({
  setItems,
  setMetadata,
}: {
  setItems: (n: number) => void;
  setMetadata: (m: Record<string, unknown>) => void;
}) {
  const now = new Date();
  const billingCutoff = new Date(now.getTime() + BILLING_WINDOW_MS);

  // Find active subscriptions expiring in the next 24h.
  const expiring = await db
    .select({
      id: hostedAgentSubscriptions.id,
      agentId: hostedAgentSubscriptions.agentId,
      expiresAt: hostedAgentSubscriptions.expiresAt,
    })
    .from(hostedAgentSubscriptions)
    .where(
      and(
        eq(hostedAgentSubscriptions.status, "active"),
        // gt expiresAt now → still active
        gt(hostedAgentSubscriptions.expiresAt, now),
        // lte expiresAt billingCutoff → expiring within 24h
        lte(hostedAgentSubscriptions.expiresAt, billingCutoff),
      ),
    )
    .limit(50);

  if (expiring.length === 0) {
    setItems(0);
    setMetadata({ renewed: 0, lapsed: 0, errored: 0 });
    return NextResponse.json({ ok: true, processed: 0 });
  }

  // Preload agents to read linked wallet addresses.
  const agentIds = expiring.map((s) => s.agentId);
  const agentRows = await db
    .select({
      id: agents.id,
      handle: agents.handle,
      linkedWalletAddress: agents.linkedWalletAddress,
    })
    .from(agents)
    .where(eq(agents.id, agentIds[0])); // drizzle inArray pattern; simplified for batch
  const agentMap = new Map<string, typeof agentRows[number]>();
  for (const a of agentRows) agentMap.set(a.id, a);

  // Refetch for the full batch (drizzle inArray with single-row case)
  const allAgents = await db.query.agents.findMany({
    where: (a, { inArray }) => inArray(a.id, agentIds),
    columns: { id: true, handle: true, linkedWalletAddress: true },
  });
  for (const a of allAgents) agentMap.set(a.id, a);

  const results: PerSubOutcome[] = [];

  for (const sub of expiring) {
    const agent = agentMap.get(sub.agentId);
    if (!agent || !agent.linkedWalletAddress) {
      // Can't renew without a linked wallet. Lapse.
      await lapseSubscription(sub.id, sub.agentId, "no_linked_wallet");
      results.push({
        subscriptionId: sub.id,
        agentId: sub.agentId,
        outcome: "lapsed",
        detail: "no_linked_wallet",
      });
      continue;
    }

    try {
      const result = await pullStake(
        agent.linkedWalletAddress as `0x${string}`,
        MONTHLY_FEE_USDC,
      );
      // Success — insert a new 'monthly' row + expire the old one
      const newStart = sub.expiresAt;
      const newExpires = new Date(
        newStart.getTime() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000,
      );
      await db.transaction(async (tx) => {
        await tx
          .update(hostedAgentSubscriptions)
          .set({ status: "expired" })
          .where(eq(hostedAgentSubscriptions.id, sub.id));
        await tx.insert(hostedAgentSubscriptions).values({
          agentId: sub.agentId,
          status: "active",
          paidAmountUsdc: MONTHLY_FEE_USDC,
          paymentTxHash: result.txHash,
          kind: "monthly",
          startsAt: newStart,
          expiresAt: newExpires,
        });
      });
      results.push({
        subscriptionId: sub.id,
        agentId: sub.agentId,
        outcome: "renewed",
        detail: result.txHash,
      });
    } catch (err) {
      const detail =
        err instanceof StakePullError
          ? `payment_${err.code}`
          : err instanceof Error
            ? err.message
            : String(err);
      log.warn(
        { err, agentId: sub.agentId, subscriptionId: sub.id },
        "hosted-billing renewal failed; lapsing",
      );
      await lapseSubscription(sub.id, sub.agentId, detail);
      results.push({
        subscriptionId: sub.id,
        agentId: sub.agentId,
        outcome: "lapsed",
        detail,
      });
    }
  }

  const renewed = results.filter((r) => r.outcome === "renewed").length;
  const lapsed = results.filter((r) => r.outcome === "lapsed").length;
  const errored = results.filter((r) => r.outcome === "error").length;
  setItems(renewed);
  setMetadata({ renewed, lapsed, errored });
  return NextResponse.json({ ok: true, renewed, lapsed, errored, results });
}

/**
 * Mark a subscription expired AND flip the agent back to MCP mode so
 * the hosted-agent-loop stops trying to play turns. The owner can
 * re-enable any time via coliseum_agent_hosted_enable (which re-pays
 * the $1 setup + starts a fresh 30-day subscription).
 */
async function lapseSubscription(
  subscriptionId: string,
  agentId: string,
  reason: string,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(hostedAgentSubscriptions)
      .set({ status: "expired" })
      .where(eq(hostedAgentSubscriptions.id, subscriptionId));
    await tx
      .update(agents)
      .set({ executionMode: "mcp" })
      .where(eq(agents.id, agentId));
  });
  log.info({ subscriptionId, agentId, reason }, "hosted subscription lapsed");
}
