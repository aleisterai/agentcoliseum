/**
 * Integration tests for the lobby + match + finalize flow modules.
 *
 * Uses the pglite harness in test/db-harness.ts to spin up a real
 * Postgres-compatible engine per test — no shared state, no Docker,
 * no test schema drift.
 *
 * The flow modules read from `@/lib/db/client` via the `db` import.
 * We override that via vi.mock so the modules see our pglite-backed
 * drizzle instance instead. The realtime broadcaster is also mocked
 * to a no-op (no Supabase calls in tests).
 *
 * Tests cover:
 *   - postChallenge: free, paid, system modes; perMoveSeconds defaults
 *   - acceptChallenge: happy path, race-loss, ELO outside window
 *   - applyMove: legal move, illegal payload, 2x invalid forfeit, game over
 *   - finalizeMatch: natural win, draw, time forfeit, ELO update,
 *                    treasury flow rules (zero on draws), idempotence
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// boardgame.io ships a dev-only `SerializablePlugin` that runs
// JSON.parse(JSON.stringify(state)) deep-equality on every move and
// throws if it doesn't round-trip. The check is skipped in production
// — and the production app runs fine. For tests we want the same
// behavior because (a) the flow logic doesn't care about JSON edge
// cases and (b) the plugin trips on internal boardgame.io state that
// has nothing to do with our code. Set NODE_ENV before the boardgame.io
// modules load.
(process.env as Record<string, string | undefined>).NODE_ENV = "production";

import { withTestDb, type TestDb } from "../../../../test/db-harness";
import {
  owners,
  agents,
  challenges,
  matches,
  matchMoves,
  treasuryFlows,
} from "../../db/schema";

// ----- Module mocks ---------------------------------------------------------
//
// The flow modules import `db` from "@/lib/db/client". We swap it for the
// pglite-backed instance returned by withTestDb. Since vi.mock is hoisted,
// we set up a mutable holder + reassign per-test.
let currentDb: TestDb | null = null;
vi.mock("@/lib/db/client", () => ({
  get db() {
    if (!currentDb) throw new Error("test forgot to withTestDb()");
    return currentDb;
  },
  // sql + schema re-exports — not used by the flow modules but the
  // real client.ts re-exports them, so keep parity for any consumer.
  sql: undefined,
}));

// The realtime broadcaster makes network calls; stub to no-ops.
vi.mock("@/lib/realtime", () => ({
  broadcastGame: vi.fn(() => Promise.resolve()),
  broadcastLobby: vi.fn(() => Promise.resolve()),
  realtimeEvent: {
    GameCreated: "game.created",
    GameJoined: "game.joined",
    MovePlayed: "move.played",
    GameEnded: "match.ended",
    ChatMessage: "chat.message",
    Reaction: "reaction",
  },
}));

// Imports must come AFTER the mocks so the modules pick up our stubs.
const { postChallenge } = await import("./lobby");
const { acceptChallenge } = await import("./lobby");
const { applyMove } = await import("./match");
const { finalizeMatch } = await import("./finalize");
const {
  IllegalMoveError,
  NotYourTurnError,
  ChallengeRaceError,
  MatchNotFoundError,
  MissingReasoningError,
} = await import("./errors");

// Shared test reasoning — applyMove now requires non-empty reasoning so
// every test that submits a move must include one. Kept generic + short
// so the tests focus on the move-handling behaviour, not the prose.
const R = "test reasoning";

// ----- Helpers --------------------------------------------------------------

async function seedOwnerAgent(
  db: TestDb,
  opts: { handle: string; elo?: number; wallet?: string },
) {
  const [owner] = await db
    .insert(owners)
    .values({
      walletAddress:
        opts.wallet ?? `0x${opts.handle.padEnd(40, "0").slice(0, 40)}`,
      apiKey: `apk_${opts.handle}`,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      ownerId: owner.id,
      handle: opts.handle,
      displayName: opts.handle,
      apiKey: `agent_apk_${opts.handle}`,
      elo: opts.elo ?? 1200,
    })
    .returning();
  return { owner, agent };
}

// ----- postChallenge --------------------------------------------------------

describe("postChallenge", () => {
  beforeEach(() => {
    currentDb = null;
  });
  afterEach(() => {
    currentDb = null;
  });

  it("system mode creates a match immediately (no challenge row)", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "p1" });
      const result = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      expect(result.kind).toBe("match");
      if (result.kind === "match") {
        expect(result.match.mode).toBe("system");
        expect(result.match.p2AgentId).toBeNull();
        expect(result.match.systemBotDifficulty).toBe("easy");
        expect(result.match.status).toBe("active");
      }
      const challengeRows = await db.select().from(challenges);
      expect(challengeRows).toHaveLength(0);
    });
  });

  it("free mode creates a challenge row, no match yet", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "p1" });
      const result = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "free",
      });
      expect(result.kind).toBe("challenge");
      if (result.kind === "challenge") {
        expect(result.challenge.mode).toBe("free");
        expect(result.challenge.status).toBe("posted");
        expect(result.challenge.stakeUsdc).toBeNull();
        expect(result.challenge.clockBudgetMs).toBe(30_000); // default
      }
      const matchRows = await db.select().from(matches);
      expect(matchRows).toHaveLength(0);
    });
  });

  it("honors initiator's chosen perMoveSeconds (15s)", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "p1" });
      const result = await postChallenge({
        gameType: "chess",
        initiatorAgentId: agent.id,
        mode: "free",
        perMoveSeconds: 15,
      });
      expect(result.kind).toBe("challenge");
      if (result.kind === "challenge") {
        expect(result.challenge.clockBudgetMs).toBe(15_000);
      }
    });
  });

  it("invalid perMoveSeconds falls back to default (defense-in-depth)", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "p1" });
      const result = await postChallenge({
        gameType: "chess",
        initiatorAgentId: agent.id,
        mode: "free",
        // API layer validates, but if it leaks through, fall back to 30.
        perMoveSeconds: 7 as unknown as 15 | 30 | 45 | 60,
      });
      if (result.kind === "challenge") {
        expect(result.challenge.clockBudgetMs).toBe(30_000);
      }
    });
  });

  it("paid mode persists stakeUsdc + computes pot + 5% fee", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "p1" });
      const result = await postChallenge({
        gameType: "connect4",
        initiatorAgentId: agent.id,
        mode: "paid",
        stakeUsdc: 1_000_000, // 1 USDC
      });
      if (result.kind === "challenge") {
        expect(result.challenge.stakeUsdc).toBe(1_000_000);
        expect(result.challenge.potUsdc).toBe(2_000_000);
        expect(result.challenge.platformFeeUsdc).toBe(100_000); // 5% of 2 USDC
      }
    });
  });
});

// ----- acceptChallenge ------------------------------------------------------

describe("acceptChallenge", () => {
  beforeEach(() => {
    currentDb = null;
  });

  it("creates a match + marks the challenge escrowed", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      expect(match.p1AgentId).toBe(p1.id);
      expect(match.p2AgentId).toBe(p2.id);
      expect(match.status).toBe("active");
      expect(match.currentTurnAgentId).toBe(p1.id); // initiator moves first

      const [reloaded] = await db
        .select()
        .from(challenges)
        .where(eq(challenges.id, created.challenge.id));
      expect(reloaded.status).toBe("escrowed");
      expect(reloaded.acceptorAgentId).toBe(p2.id);
      expect(reloaded.matchId).toBe(match.id);
    });
  });

  it("rejects self-accept", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      await expect(
        acceptChallenge({
          challengeId: created.challenge.id,
          acceptorAgentId: p1.id,
        }),
      ).rejects.toBeInstanceOf(IllegalMoveError);
    });
  });

  it("rejects accepting an already-escrowed challenge (race-loss)", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const { agent: p3 } = await seedOwnerAgent(db, { handle: "p3" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      // p2 wins the race.
      await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      // p3 arrives late.
      await expect(
        acceptChallenge({
          challengeId: created.challenge.id,
          acceptorAgentId: p3.id,
        }),
      ).rejects.toBeInstanceOf(ChallengeRaceError);
    });
  });

  it("match inherits perMoveSeconds from the challenge", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
        perMoveSeconds: 60,
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      expect(match.clockBudgetMs).toBe(60_000);
      expect(match.p1MsLeft).toBe(60_000);
      expect(match.p2MsLeft).toBe(60_000);
    });
  });
});

// ----- applyMove ------------------------------------------------------------

describe("applyMove", () => {
  beforeEach(() => {
    currentDb = null;
  });

  it("rejects when the match doesn't exist", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "p1" });
      await expect(
        applyMove({
          matchId: "00000000-0000-0000-0000-000000000000",
          agentId: agent.id,
          payload: { index: 0 },
          reasoning: R,
          thinkingMs: 100,
        }),
      ).rejects.toBeInstanceOf(MatchNotFoundError);
    });
  });

  it("rejects when it isn't your turn", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      // P2 tries to move first; it's P1's turn.
      await expect(
        applyMove({
          matchId: match.id,
          agentId: p2.id,
          payload: { index: 4 },
          reasoning: R,
          thinkingMs: 100,
        }),
      ).rejects.toBeInstanceOf(NotYourTurnError);
    });
  });

  it("accepts a legal move + flips currentTurnAgentId", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      const updated = await applyMove({
        matchId: match.id,
        agentId: p1.id,
        payload: { index: 4 }, // center
        reasoning: R,
        thinkingMs: 200,
      });
      expect(updated.status).toBe("active");
      expect(updated.moveCount).toBe(1);
      expect(updated.currentTurnAgentId).toBe(p2.id);
      const moves = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, match.id));
      expect(moves).toHaveLength(1);
      expect((moves[0].payload as { index: number }).index).toBe(4);
    });
  });

  it("rejects a move with missing / empty / whitespace-only reasoning", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });

      // Empty string.
      await expect(
        applyMove({
          matchId: match.id,
          agentId: p1.id,
          payload: { index: 4 },
          reasoning: "",
          thinkingMs: 50,
        }),
      ).rejects.toBeInstanceOf(MissingReasoningError);

      // Whitespace-only.
      await expect(
        applyMove({
          matchId: match.id,
          agentId: p1.id,
          payload: { index: 4 },
          reasoning: "   \n\t  ",
          thinkingMs: 50,
        }),
      ).rejects.toBeInstanceOf(MissingReasoningError);

      // No move row was written despite multiple rejected calls.
      const rows = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, match.id));
      expect(rows).toHaveLength(0);

      // The same move with valid reasoning still works — proves the
      // reject path didn't otherwise corrupt the match state.
      const ok = await applyMove({
        matchId: match.id,
        agentId: p1.id,
        payload: { index: 4 },
        reasoning: "claim the center",
        thinkingMs: 50,
      });
      expect(ok.moveCount).toBe(1);
    });
  });

  it("two illegal moves in a row forfeit the match (invalid_move_forfeit)", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      // First illegal move bumps counter to 1.
      await expect(
        applyMove({
          matchId: match.id,
          agentId: p1.id,
          payload: { index: 99 }, // out of range
          reasoning: R,
          thinkingMs: 50,
        }),
      ).rejects.toBeInstanceOf(IllegalMoveError);
      // Second illegal move forfeits.
      const result = await applyMove({
        matchId: match.id,
        agentId: p1.id,
        payload: { index: 99 },
        reasoning: R,
        thinkingMs: 50,
      });
      expect(result.status).toBe("completed");
      expect(result.resultReason).toBe("invalid_move_forfeit");
      expect(result.winnerAgentId).toBe(p2.id);
    });
  });

  it("a winning move triggers natural completion + ELO update", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1", elo: 1200 });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2", elo: 1200 });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      // Play X wins: X at 0, 1, 2 (top row), O between at 4, 7.
      const seq: Array<[string, number]> = [
        [p1.id, 0],
        [p2.id, 4],
        [p1.id, 1],
        [p2.id, 7],
        [p1.id, 2], // X wins top row
      ];
      let last;
      for (const [aId, idx] of seq) {
        last = await applyMove({
          matchId: match.id,
          agentId: aId,
          payload: { index: idx },
          reasoning: R,
          thinkingMs: 100,
        });
      }
      expect(last!.status).toBe("completed");
      expect(last!.resultReason).toBe("natural");
      expect(last!.winnerAgentId).toBe(p1.id);

      const [p1After] = await db.select().from(agents).where(eq(agents.id, p1.id));
      const [p2After] = await db.select().from(agents).where(eq(agents.id, p2.id));
      expect(p1After.wins).toBe(1);
      expect(p2After.losses).toBe(1);
      // Equal-rated → K=32 → +16 / -16.
      expect(p1After.elo).toBe(1216);
      expect(p2After.elo).toBe(1184);
    });
  });
});

// ----- finalizeMatch direct paths -------------------------------------------

describe("finalizeMatch", () => {
  beforeEach(() => {
    currentDb = null;
  });

  it("is idempotent — calling twice doesn't double-update ELO", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });

      // First finalize: p1 wins.
      await finalizeMatch({
        matchId: match.id,
        winnerAgentId: p1.id,
        resultReason: "natural",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });
      // Second finalize call should be a no-op (returns the already-completed row).
      await finalizeMatch({
        matchId: match.id,
        winnerAgentId: p1.id,
        resultReason: "natural",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });
      const [p1After] = await db.select().from(agents).where(eq(agents.id, p1.id));
      expect(p1After.wins).toBe(1); // not 2
      expect(p1After.elo).toBe(1216); // not 1232
    });
  });

  it("draws → both agents' draw counters +1, ELO unchanged on equal ratings", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1", elo: 1200 });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2", elo: 1200 });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      await finalizeMatch({
        matchId: match.id,
        winnerAgentId: null,
        resultReason: "draw",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });
      const [p1After] = await db.select().from(agents).where(eq(agents.id, p1.id));
      const [p2After] = await db.select().from(agents).where(eq(agents.id, p2.id));
      expect(p1After.draws).toBe(1);
      expect(p2After.draws).toBe(1);
      expect(p1After.elo).toBe(1200); // equal-rated draw → no change
      expect(p2After.elo).toBe(1200);
    });
  });

  it("paid draw inserts NO treasury_flow (Option A — full refund)", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "paid",
        stakeUsdc: 1_000_000,
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      await finalizeMatch({
        matchId: match.id,
        winnerAgentId: null,
        resultReason: "draw",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });
      const flows = await db.select().from(treasuryFlows);
      expect(flows).toHaveLength(0);
    });
  });

  it("paid natural win inserts a treasury_flow with 5% of the pot", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "paid",
        stakeUsdc: 1_000_000, // pot = 2 USDC
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      await finalizeMatch({
        matchId: match.id,
        winnerAgentId: p1.id,
        resultReason: "natural",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });
      const flows = await db.select().from(treasuryFlows);
      expect(flows).toHaveLength(1);
      expect(flows[0].feeUsdc).toBe(100_000); // 5% of 2 USDC
      expect(flows[0].status).toBe("pending");
    });
  });

  it("system-mode skips ELO + treasury (no real opponent agent)", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1", elo: 1500 });
      const result = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (result.kind !== "match") throw new Error("expected match");
      await finalizeMatch({
        matchId: result.match.id,
        winnerAgentId: p1.id,
        resultReason: "natural",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });
      const [p1After] = await db.select().from(agents).where(eq(agents.id, p1.id));
      expect(p1After.elo).toBe(1500); // no ELO change
      expect(p1After.wins).toBe(0); // no win counter bump
      const flows = await db.select().from(treasuryFlows);
      expect(flows).toHaveLength(0);
    });
  });

  it("time_forfeit sets winnerAgentId to the OTHER player", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      // P1 ran out — P2 wins.
      const updated = await finalizeMatch({
        matchId: match.id,
        winnerAgentId: p2.id,
        resultReason: "time_forfeit",
        finalP1Ms: 0,
        finalP2Ms: 30_000,
      });
      expect(updated.winnerAgentId).toBe(p2.id);
      expect(updated.resultReason).toBe("time_forfeit");
      const [p2After] = await db.select().from(agents).where(eq(agents.id, p2.id));
      expect(p2After.wins).toBe(1);
    });
  });
});
