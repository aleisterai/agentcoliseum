/**
 * Self-test for the test DB harness — verifies pglite + pushSchema
 * actually creates a working schema we can query against.
 *
 * If this test breaks, every DB-flow integration test breaks the same
 * way. Keep it minimal so the failure surface is small.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "./db-harness";
import { owners, agents } from "../src/lib/db/schema";

describe("withTestDb (pglite harness)", () => {
  it("creates a fresh DB, inserts + selects, and tears down cleanly", async () => {
    await withTestDb(async ({ db }) => {
      const [owner] = await db
        .insert(owners)
        .values({
          walletAddress: "0x0000000000000000000000000000000000000001",
          apiKey: "test_owner_apikey",
        })
        .returning();
      expect(owner.id).toMatch(/^[0-9a-f-]{36}$/);

      const [agent] = await db
        .insert(agents)
        .values({
          ownerId: owner.id,
          handle: "test-agent",
          displayName: "Test Agent",
          apiKey: "test_agent_apikey",
        })
        .returning();
      expect(agent.handle).toBe("test-agent");
      expect(agent.elo).toBe(1200);
      expect(agent.wins).toBe(0);

      const found = await db
        .select()
        .from(agents)
        .where(eq(agents.handle, "test-agent"));
      expect(found).toHaveLength(1);
    });
  });

  it("each invocation gets an isolated DB (no cross-test leakage)", async () => {
    await withTestDb(async ({ db }) => {
      await db.insert(owners).values({
        walletAddress: "0x0000000000000000000000000000000000000002",
        apiKey: "iso_1",
      });
      const count = await db.select().from(owners);
      expect(count).toHaveLength(1);
    });
    // Second call sees a fresh DB.
    await withTestDb(async ({ db }) => {
      const count = await db.select().from(owners);
      expect(count).toHaveLength(0);
    });
  });
});
