/**
 * Tests for the withinBudget Guardian check + computeEffectiveCap.
 *
 * This is the spending cap that gates every money-moving action
 * (challenge.propose / accept / tournament entry). It picks the SMALLEST
 * of: soft|hard cap, on-chain allowance, rookie cap — and denies stakes
 * above it. Until now it had zero automated coverage.
 *
 * The on-chain allowance read is mocked; the owner row is read from the
 * pglite harness via the standard db/client mock.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { withTestDb, type TestDb } from "../../../../test/db-harness";
import { owners } from "../../db/schema";
import type { Agent } from "../../db/schema";

let currentDb: TestDb | null = null;
vi.mock("@/lib/db/client", () => ({
  get db() {
    if (!currentDb) throw new Error("test forgot to withTestDb()");
    return currentDb;
  },
  sql: undefined,
}));

vi.mock("@/lib/chain/allowance", () => ({
  readUsdcAllowance: vi.fn(),
}));

import { readUsdcAllowance } from "@/lib/chain/allowance";
const mockAllowance = vi.mocked(readUsdcAllowance);

const { computeEffectiveCap, withinBudget } = await import("./within-budget");

afterEach(() => {
  currentDb = null;
  mockAllowance.mockReset();
});

let seq = 0;
async function makeOwner(db: TestDb): Promise<string> {
  seq += 1;
  const [owner] = await db
    .insert(owners)
    .values({
      walletAddress: `0xowner${seq.toString().padStart(34, "0")}`,
      apiKey: `cap-owner-key-${seq}`,
    })
    .returning();
  return owner.id;
}

describe("computeEffectiveCap", () => {
  it("rookie cap ($10) binds for an agent's first 5 matches", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      mockAllowance.mockResolvedValue(100_000_000n); // $100 allowance
      const ownerId = await makeOwner(db);

      const cap = await computeEffectiveCap({
        ownerId,
        stakeCapHardUsdc: 50_000_000, // $50
        stakeCapSoftUsdc: null,
        wins: 1,
        losses: 1,
        draws: 0, // 2 matches < 5 → rookie active
      });

      expect(cap.effective).toBe(10_000_000); // $10 rookie cap
      expect(cap.bindingConstraint).toBe("rookie");
    });
  });

  it("allowance binds when it's the smallest constraint", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      mockAllowance.mockResolvedValue(3_000_000n); // $3 allowance
      const ownerId = await makeOwner(db);

      const cap = await computeEffectiveCap({
        ownerId,
        stakeCapHardUsdc: 50_000_000,
        stakeCapSoftUsdc: null,
        wins: 5,
        losses: 5,
        draws: 0, // 10 matches → rookie cleared
      });

      expect(cap.effective).toBe(3_000_000);
      expect(cap.bindingConstraint).toBe("allowance");
    });
  });

  it("soft cap binds below hard cap", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      mockAllowance.mockResolvedValue(100_000_000n);
      const ownerId = await makeOwner(db);

      const cap = await computeEffectiveCap({
        ownerId,
        stakeCapHardUsdc: 50_000_000,
        stakeCapSoftUsdc: 8_000_000, // $8 soft
        wins: 10,
        losses: 10,
        draws: 0,
      });

      expect(cap.effective).toBe(8_000_000);
      expect(cap.bindingConstraint).toBe("soft");
    });
  });
});

describe("withinBudget", () => {
  function agentWith(fields: Partial<Agent> & { ownerId: string | null }): Agent {
    // The check only reads ownerId + caps + W/L/D; cast a minimal object.
    return {
      ownerId: fields.ownerId,
      stakeCapHardUsdc: fields.stakeCapHardUsdc ?? 50_000_000,
      stakeCapSoftUsdc: fields.stakeCapSoftUsdc ?? null,
      wins: fields.wins ?? 10,
      losses: fields.losses ?? 10,
      draws: fields.draws ?? 0,
    } as unknown as Agent;
  }

  it("denies a stake above the effective cap", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      mockAllowance.mockResolvedValue(100_000_000n);
      const ownerId = await makeOwner(db);

      const denial = await withinBudget("challenge.propose", {
        agent: agentWith({ ownerId, stakeCapHardUsdc: 10_000_000 }),
        stakeUsdc: 20_000_000, // $20 > $10 hard cap
      });

      expect(denial).not.toBeNull();
      expect(denial?.code).toBe("over_budget");
    });
  });

  it("allows a stake within the effective cap", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      mockAllowance.mockResolvedValue(100_000_000n);
      const ownerId = await makeOwner(db);

      const denial = await withinBudget("challenge.propose", {
        agent: agentWith({ ownerId, stakeCapHardUsdc: 50_000_000 }),
        stakeUsdc: 5_000_000, // $5 < $50
      });

      expect(denial).toBeNull();
    });
  });

  it("passes free matches (stake 0) without touching allowance", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const denial = await withinBudget("challenge.propose", {
        agent: agentWith({ ownerId: null }),
        stakeUsdc: 0,
      });
      expect(denial).toBeNull();
      expect(mockAllowance).not.toHaveBeenCalled();
    });
  });

  it("ignores non-money actions", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const denial = await withinBudget("match.move", {
        agent: agentWith({ ownerId: null }),
        stakeUsdc: 999_000_000,
      });
      expect(denial).toBeNull();
    });
  });
});
