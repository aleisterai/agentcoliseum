/**
 * Tests for claimSubscriptionForRenewal — the hosted-billing
 * double-charge guard.
 *
 * The claim is the idempotency primitive: only the FIRST caller flips
 * 'active' → 'renewing' and gets permission to pull payment. A retry
 * (or a concurrent run, or a re-run after a crash) sees a non-active
 * row and is refused, so the $20 can be pulled at most once per period.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { withTestDb, type TestDb } from "../../test/db-harness";
import { agents, hostedAgentSubscriptions } from "./db/schema";

let currentDb: TestDb | null = null;
vi.mock("@/lib/db/client", () => ({
  get db() {
    if (!currentDb) throw new Error("test forgot to withTestDb()");
    return currentDb;
  },
  sql: undefined,
}));

const { claimSubscriptionForRenewal } = await import("./hosted-billing-renewal");

afterEach(() => {
  currentDb = null;
});

let seq = 0;
async function makeActiveSub(
  db: TestDb,
  status: "active" | "expired" = "active",
): Promise<string> {
  seq += 1;
  const [agent] = await db
    .insert(agents)
    .values({
      handle: `host-agent-${seq}`,
      displayName: `Host Agent ${seq}`,
      apiKey: `host-key-${seq}`,
    })
    .returning();
  const [sub] = await db
    .insert(hostedAgentSubscriptions)
    .values({
      agentId: agent.id,
      status,
      paidAmountUsdc: 20_000_000,
      kind: "monthly",
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000), // +12h
    })
    .returning();
  return sub.id;
}

describe("claimSubscriptionForRenewal", () => {
  it("lets the first caller claim an active subscription", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const subId = await makeActiveSub(db);

      const won = await claimSubscriptionForRenewal(subId);
      expect(won).toBe(true);

      const sub = await db.query.hostedAgentSubscriptions.findFirst({
        where: eq(hostedAgentSubscriptions.id, subId),
      });
      expect(sub?.status).toBe("renewing");
    });
  });

  it("refuses a second claim — prevents the double-charge", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const subId = await makeActiveSub(db);

      const first = await claimSubscriptionForRenewal(subId);
      const second = await claimSubscriptionForRenewal(subId);

      expect(first).toBe(true);
      expect(second).toBe(false); // the retry is refused → no second pull
    });
  });

  it("refuses to claim a non-active subscription", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const subId = await makeActiveSub(db, "expired");

      const won = await claimSubscriptionForRenewal(subId);
      expect(won).toBe(false);
    });
  });
});
