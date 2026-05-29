/**
 * Tests for claimOrphanAgent — binding an ownerless npx agent to a human
 * owner via its `ack_` credential. Covers: orphan → bound, idempotent
 * re-claim by the same owner, refusal to steal an already-owned agent, and
 * a bad credential. DB comes from the pglite harness.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "../../test/db-harness";
import { agents, owners } from "./db/schema";

let currentDb: TestDb | null = null;
vi.mock("@/lib/db/client", () => ({
  get db() {
    if (!currentDb) throw new Error("test forgot to withTestDb()");
    return currentDb;
  },
  sql: undefined,
}));

const { claimOrphanAgent } = await import("./claim-agent");

afterEach(() => {
  currentDb = null;
});

let seq = 0;
async function makeOwner(db: TestDb): Promise<string> {
  seq += 1;
  const [o] = await db
    .insert(owners)
    .values({
      walletAddress: `0xclaim${seq.toString().padStart(34, "0")}`,
      apiKey: `claim-owner-key-${seq}`,
    })
    .returning();
  return o.id;
}
async function makeAgent(
  db: TestDb,
  opts: { apiKey: string; ownerId?: string | null },
): Promise<void> {
  seq += 1;
  await db.insert(agents).values({
    handle: `claim-agent-${seq}`,
    displayName: `Claim Agent ${seq}`,
    apiKey: opts.apiKey,
    ownerId: opts.ownerId ?? null,
  });
}

describe("claimOrphanAgent", () => {
  it("binds an orphan (owner_id NULL) to the claiming owner", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const ownerId = await makeOwner(db);
      await makeAgent(db, { apiKey: "ack_orphan_one" });

      const res = await claimOrphanAgent({ ownerId, credential: "ack_orphan_one" });
      expect(res.status).toBe("claimed");

      const row = await db.query.agents.findFirst({
        where: eq(agents.apiKey, "ack_orphan_one"),
      });
      expect(row?.ownerId).toBe(ownerId);
    });
  });

  it("is idempotent — re-claim by the same owner returns already_yours", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const ownerId = await makeOwner(db);
      await makeAgent(db, { apiKey: "ack_orphan_two", ownerId });

      const res = await claimOrphanAgent({ ownerId, credential: "ack_orphan_two" });
      expect(res.status).toBe("already_yours");
    });
  });

  it("refuses to steal an agent already owned by someone else", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const ownerA = await makeOwner(db);
      const ownerB = await makeOwner(db);
      await makeAgent(db, { apiKey: "ack_owned_byA", ownerId: ownerA });

      const res = await claimOrphanAgent({ ownerId: ownerB, credential: "ack_owned_byA" });
      expect(res.status).toBe("already_claimed");

      const row = await db.query.agents.findFirst({
        where: eq(agents.apiKey, "ack_owned_byA"),
      });
      expect(row?.ownerId).toBe(ownerA); // unchanged
    });
  });

  it("rejects an unknown / empty credential", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const ownerId = await makeOwner(db);
      expect((await claimOrphanAgent({ ownerId, credential: "ack_nope" })).status).toBe(
        "invalid_credential",
      );
      expect((await claimOrphanAgent({ ownerId, credential: "  " })).status).toBe(
        "invalid_credential",
      );
    });
  });
});
