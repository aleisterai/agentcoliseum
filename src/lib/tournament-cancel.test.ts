/**
 * Tests for cancelTournament — the P0 entry-fee-refund path.
 *
 * Uses the pglite harness (real Postgres in-process). The helper reads
 * `db` from "@/lib/db/client", so we swap that for the harness instance
 * via vi.mock (same pattern as flow/integration.test.ts).
 *
 * Covers: refund enqueue per entrant, idempotency (no double-refund on
 * repeat call), free-tournament no-op refunds, wrong-status rejection,
 * and the unresolved-recipient abort (no partial writes).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { withTestDb, type TestDb } from "../../test/db-harness";
import {
  owners,
  agents,
  tournaments,
  tournamentEntries,
  tournamentPayouts,
} from "./db/schema";

let currentDb: TestDb | null = null;
vi.mock("@/lib/db/client", () => ({
  get db() {
    if (!currentDb) throw new Error("test forgot to withTestDb()");
    return currentDb;
  },
  sql: undefined,
}));

const { cancelTournament, CancelTournamentError } = await import(
  "./tournament-cancel"
);

afterEach(() => {
  currentDb = null;
});

let seq = 0;
async function makeAgent(
  db: TestDb,
  opts: { ownerWallet?: string; linkedWallet?: string | null } = {},
): Promise<{ agentId: string }> {
  seq += 1;
  let ownerId: string | null = null;
  if (opts.ownerWallet) {
    const [owner] = await db
      .insert(owners)
      .values({
        walletAddress: opts.ownerWallet,
        apiKey: `owner-key-${seq}`,
      })
      .returning();
    ownerId = owner.id;
  }
  const [agent] = await db
    .insert(agents)
    .values({
      handle: `agent-${seq}`,
      displayName: `Agent ${seq}`,
      apiKey: `agent-key-${seq}`,
      ownerId,
      linkedWalletAddress:
        opts.linkedWallet === undefined ? null : opts.linkedWallet,
    })
    .returning();
  return { agentId: agent.id };
}

async function makeTournament(
  db: TestDb,
  opts: {
    entryFeeUsdc: number;
    size?: number;
    status?: "registering" | "running";
  },
): Promise<string> {
  const [t] = await db
    .insert(tournaments)
    .values({
      name: "Test Cup",
      gameType: "connect4",
      size: opts.size ?? 4,
      entryFeeUsdc: opts.entryFeeUsdc,
      prizePoolUsdc: 0,
      status: opts.status ?? "registering",
    })
    .returning();
  return t.id;
}

describe("cancelTournament", () => {
  it("enqueues one refund per entrant into tournament_payouts", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const fee = 5_000_000; // $5
      const tId = await makeTournament(db, { entryFeeUsdc: fee, size: 4 });
      // Two entrants (under-filled), distinct owner wallets via the join path.
      const a = await makeAgent(db, { ownerWallet: "0xowner000000000000000000000000000000000A1" });
      const b = await makeAgent(db, { ownerWallet: "0xowner000000000000000000000000000000000B2" });
      await db.insert(tournamentEntries).values([
        { tournamentId: tId, agentId: a.agentId },
        { tournamentId: tId, agentId: b.agentId },
      ]);

      const result = await cancelTournament(tId);

      expect(result.cancelled).toBe(true);
      expect(result.refundsEnqueued).toBe(2);

      const t = await db.query.tournaments.findFirst({
        where: eq(tournaments.id, tId),
      });
      expect(t?.status).toBe("cancelled");

      const payouts = await db
        .select()
        .from(tournamentPayouts)
        .where(eq(tournamentPayouts.tournamentId, tId));
      expect(payouts).toHaveLength(2);
      for (const p of payouts) {
        expect(p.amountUsdc).toBe(fee);
        expect(p.status).toBe("pending");
      }
      const recipients = payouts.map((p) => p.recipientAddress).sort();
      expect(recipients).toEqual(
        [
          "0xowner000000000000000000000000000000000A1",
          "0xowner000000000000000000000000000000000B2",
        ].sort(),
      );
    });
  });

  it("is idempotent — a repeat call does not double-refund", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const tId = await makeTournament(db, { entryFeeUsdc: 5_000_000 });
      const a = await makeAgent(db, { ownerWallet: "0xowner00000000000000000000000000000000C33" });
      await db
        .insert(tournamentEntries)
        .values({ tournamentId: tId, agentId: a.agentId });

      const first = await cancelTournament(tId);
      const second = await cancelTournament(tId);

      expect(first.cancelled).toBe(true);
      expect(first.refundsEnqueued).toBe(1);
      // Second call sees an already-cancelled tournament → no-op.
      expect(second.cancelled).toBe(false);
      expect(second.refundsEnqueued).toBe(0);

      const payouts = await db
        .select()
        .from(tournamentPayouts)
        .where(eq(tournamentPayouts.tournamentId, tId));
      // Exactly one refund row — the UNIQUE(tournamentId, recipient)
      // index + the already-cancelled short-circuit both prevent dupes.
      expect(payouts).toHaveLength(1);
    });
  });

  it("flips a free tournament to cancelled with zero refunds", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const tId = await makeTournament(db, { entryFeeUsdc: 0 });
      const a = await makeAgent(db, { linkedWallet: null }); // free-tier, no wallet
      await db
        .insert(tournamentEntries)
        .values({ tournamentId: tId, agentId: a.agentId });

      const result = await cancelTournament(tId);

      expect(result.cancelled).toBe(true);
      expect(result.refundsEnqueued).toBe(0);
      const payouts = await db
        .select()
        .from(tournamentPayouts)
        .where(eq(tournamentPayouts.tournamentId, tId));
      expect(payouts).toHaveLength(0);
    });
  });

  it("rejects cancelling a non-registering tournament", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const tId = await makeTournament(db, {
        entryFeeUsdc: 5_000_000,
        status: "running",
      });
      await expect(cancelTournament(tId)).rejects.toMatchObject({
        code: "wrong_status",
      });
      expect(CancelTournamentError).toBeDefined();
    });
  });

  it("aborts (no partial writes) when a paid entrant has no resolvable wallet", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const tId = await makeTournament(db, { entryFeeUsdc: 5_000_000 });
      // Paid tournament but the agent has neither a linked wallet nor an
      // owner → unresolvable refund recipient.
      const a = await makeAgent(db, { linkedWallet: null });
      await db
        .insert(tournamentEntries)
        .values({ tournamentId: tId, agentId: a.agentId });

      await expect(cancelTournament(tId)).rejects.toMatchObject({
        code: "unresolved_recipient",
      });

      // Nothing partially committed: tournament still registering, no payouts.
      const t = await db.query.tournaments.findFirst({
        where: eq(tournaments.id, tId),
      });
      expect(t?.status).toBe("registering");
      const payouts = await db
        .select()
        .from(tournamentPayouts)
        .where(eq(tournamentPayouts.tournamentId, tId));
      expect(payouts).toHaveLength(0);
    });
  });
});
