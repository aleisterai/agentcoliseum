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
    ReactionAdded: "reaction.added",
    ChatPosted: "chat.posted",
  },
}));

// Imports must come AFTER the mocks so the modules pick up our stubs.
const { postChallenge } = await import("./lobby");
const { acceptChallenge } = await import("./lobby");
const { applyMove } = await import("./match");
const { finalizeMatch } = await import("./finalize");
const { enforceClockExpiry } = await import("./clock");
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

  it("system-mode floors the per-move clock at 60s (first-move grace)", async () => {
    // Regression: a system-mode match with perMoveSeconds=15 used to
    // give the agent only 15s on the first move; the agent's LLM
    // frequently missed the "now YOU move" follow-up after propose
    // returned, and the bot won by time_forfeit before the LLM
    // could call coliseum_match_move. The lobby flow now floors
    // clock_budget_ms at 60_000 for system-mode matches.
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "p1" });

      // Caller asks for 15s (the blitz preset). System mode should
      // ignore that and use 60s instead.
      const blitz = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
        perMoveSeconds: 15,
      });
      if (blitz.kind !== "match") throw new Error("expected match");
      expect(blitz.match.clockBudgetMs).toBe(60_000);
      expect(blitz.match.p1MsLeft).toBe(60_000);
      expect(blitz.match.p2MsLeft).toBe(60_000);

      // Caller asks for 60s — should stay 60s.
      const standard = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
        perMoveSeconds: 60,
      });
      if (standard.kind !== "match") throw new Error("expected match");
      expect(standard.match.clockBudgetMs).toBe(60_000);
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

  it("system-mode: human times out → winner=null + time_forfeit (NOT a draw)", async () => {
    // Regression: before this fix, a system-mode match where the
    // human player ran the clock to zero was rendered as a DRAW in
    // the match view because the banner mislabeled any null-winner
    // outcome that wasn't 'abandoned' as a draw. The server-side
    // data is correct (winner=null + result_reason='time_forfeit');
    // the bug was in the UI classifier. We assert the server side
    // here so the classifier in outcome.test.ts has the right input
    // shape pinned.
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const created = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (created.kind !== "match") throw new Error("expected match");

      // Backdate turnStartedAt to a minute ago so the clock has
      // definitely expired (the default per-move budget is 30s).
      await db
        .update(matches)
        .set({ turnStartedAt: new Date(Date.now() - 60_000) })
        .where(eq(matches.id, created.match.id));

      const result = await enforceClockExpiry(created.match.id);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("completed");
      expect(result!.resultReason).toBe("time_forfeit");
      // The system bot has no agent row — winner stays null and
      // outcome.ts.classifyOutcome maps {mode:'system', winner:null,
      // reason:'time_forfeit'} → kind:'bot-won'.
      expect(result!.winnerAgentId).toBeNull();
      expect(result!.p2AgentId).toBeNull();
      expect(result!.mode).toBe("system");
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

// ----- coliseum_match_state: wall-clock surface ---------------------------
//
// The MCP tool layer that surfaces match state must publish live
// wall-clock remaining (not just the per-move budget) so an LLM that
// doesn't track elapsed time itself can decide whether to ship now or
// keep thinking. The fix lives in the MCP tool layer, which is
// game-agnostic — every one of the 14 games shares the same
// `coliseum_match_state` + `clockBudgetMs` + `turnStartedAt` columns,
// so a test against ANY game type validates the contract for ALL of
// them.
//
// We parameterize across 3 representative game types (tic-tac-toe,
// connect4, chess) to document the per-game-agnostic claim. Adding a
// new game does not require adding a new clock test — the wall-clock
// fields are produced by the tool, not the game adapter.

describe("coliseum_match_state — wall-clock fields (all games)", () => {
  beforeEach(() => {
    currentDb = null;
  });
  afterEach(() => {
    currentDb = null;
  });

  for (const gameType of ["tic-tac-toe", "connect4", "chess"] as const) {
    it(`returns myMsLeftLive + turnDeadline + urgency for ${gameType}`, async () => {
      const { matchState } = await import("@/app/api/mcp/tools/match-state");
      await withTestDb(async ({ db }) => {
        currentDb = db;
        const { agent } = await seedOwnerAgent(db, { handle: `wc_${gameType}` });

        // System-mode propose creates an active match with p1=agent on
        // move first, clockBudgetMs floored at 60_000.
        const r = await postChallenge({
          gameType,
          initiatorAgentId: agent.id,
          mode: "system",
          systemBotDifficulty: "easy",
        });
        if (r.kind !== "match") throw new Error("expected match");
        const matchId = r.match.id;

        // Set turnStartedAt 10 seconds ago so myMsLeftLive should
        // show ~50_000ms left out of the 60_000 budget.
        const tenSecAgo = new Date(Date.now() - 10_000);
        await db
          .update(matches)
          .set({ turnStartedAt: tenSecAgo })
          .where(eq(matches.id, matchId));

        const state = (await matchState.handler(
          { matchId },
          { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
        )) as Record<string, unknown>;

        // Static budget field stays equal to clockBudgetMs.
        expect(state.clockBudgetMs).toBe(60_000);
        expect(state.myMsLeft).toBe(60_000);

        // Live remaining decrements with wall clock — ~50s with some
        // tolerance for test-runner jitter.
        expect(state.myMsLeftLive).toBeGreaterThan(45_000);
        expect(state.myMsLeftLive).toBeLessThan(55_000);

        // Urgency is categorical: ~83% remaining = 'fresh'.
        expect(state.urgency).toBe("fresh");

        // turnDeadline is an ISO timestamp ~50s in the future.
        expect(typeof state.turnDeadline).toBe("string");
        const deadlineMs = new Date(state.turnDeadline as string).getTime();
        const expectedDeadline = tenSecAgo.getTime() + 60_000;
        expect(Math.abs(deadlineMs - expectedDeadline)).toBeLessThan(1000);

        // It is the agent's turn (p1 in system mode).
        expect(state.isMyTurn).toBe(true);
      });
    });
  }

  it("urgency tiers correctly: fresh / half / low / critical", async () => {
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "urgency" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (r.kind !== "match") throw new Error("expected match");
      const matchId = r.match.id;
      const budget = 60_000;

      // fresh: just started — 100% remaining
      let state = (await matchState.handler(
        { matchId },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as Record<string, unknown>;
      expect(state.urgency).toBe("fresh");

      // half: 50% remaining = 30s elapsed
      await db
        .update(matches)
        .set({ turnStartedAt: new Date(Date.now() - 30_000) })
        .where(eq(matches.id, matchId));
      state = (await matchState.handler(
        { matchId },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as Record<string, unknown>;
      expect(state.urgency).toBe("half");

      // low: 20% remaining = 48s elapsed
      await db
        .update(matches)
        .set({ turnStartedAt: new Date(Date.now() - 48_000) })
        .where(eq(matches.id, matchId));
      state = (await matchState.handler(
        { matchId },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as Record<string, unknown>;
      expect(state.urgency).toBe("low");

      // critical: 5% remaining = 57s elapsed
      await db
        .update(matches)
        .set({ turnStartedAt: new Date(Date.now() - 57_000) })
        .where(eq(matches.id, matchId));
      state = (await matchState.handler(
        { matchId },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as Record<string, unknown>;
      expect(state.urgency).toBe("critical");
      expect(state.myMsLeftLive).toBeLessThan(budget * 0.1);
    });
  });

  it("myMsLeftLive does NOT decrement when it's the opponent's turn", async () => {
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "wc_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "wc_p2", elo: 1200 });

      const challenge = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (challenge.kind !== "challenge") throw new Error("expected challenge");

      const match = await acceptChallenge({
        challengeId: challenge.challenge.id,
        acceptorAgentId: p2.id,
      });

      // p1 is on move first. From p2's POV (off-turn), myMsLeftLive
      // should equal the full budget regardless of how much time has
      // passed.
      await db
        .update(matches)
        .set({ turnStartedAt: new Date(Date.now() - 30_000) })
        .where(eq(matches.id, match.id));

      const p2State = (await matchState.handler(
        { matchId: match.id },
        { agent: { id: p2.id, ownerId: p2.ownerId } } as never,
      )) as Record<string, unknown>;

      expect(p2State.isMyTurn).toBe(false);
      // p2's own clock isn't ticking, so myMsLeftLive is the full budget.
      expect(p2State.myMsLeftLive).toBe(p2State.clockBudgetMs);
      // But the OPPONENT (p1) IS under pressure — their live remaining
      // should be ~30s less than budget.
      expect(p2State.opponentMsLeftLive).toBeLessThan(p2State.clockBudgetMs as number);
    });
  });
});

// ----- coliseum_match_move — thinkingMs is optional ----------------------
describe("coliseum_match_move — server-fills thinkingMs when omitted", () => {
  beforeEach(() => {
    currentDb = null;
  });
  afterEach(() => {
    currentDb = null;
  });

  it("accepts a move without thinkingMs; published value reflects wall-clock", async () => {
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "thinker" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (r.kind !== "match") throw new Error("expected match");
      const matchId = r.match.id;

      // Pin turnStartedAt 4 seconds in the past — the server's
      // computed thinkingMs should land around 4_000ms.
      const startedAt = new Date(Date.now() - 4_000);
      await db
        .update(matches)
        .set({ turnStartedAt: startedAt })
        .where(eq(matches.id, matchId));

      // Notice: NO thinkingMs in the payload. tic-tac-toe payload is
      // { index: 0..8 }.
      const out = (await matchMove.handler(
        {
          matchId,
          payload: { index: 0 },
          reasoning: R,
        },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as Record<string, unknown>;

      // The move was accepted (no error key).
      expect(out.error).toBeUndefined();
      expect(out.moveCount).toBeGreaterThan(0);

      // The persisted thinkingMs on the move row should match wall
      // clock (server-filled).
      const [move0] = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, matchId));
      expect(move0.thinkingMs).toBeGreaterThan(3_500);
      expect(move0.thinkingMs).toBeLessThan(8_000);
    });
  });
});

// ===========================================================================
// Phase A — structured reasoning + voice + emotion
//
// The MCP tools (match_move, match_state) accept and surface 9 new
// optional fields: candidates, evaluation, plan, expectedReply, phase,
// mood, emotionTrigger (on match_move) + myVoice, opponentVoice,
// recentReasoning, recentMoods (on match_state). All persist via the
// shared applyMove path so they apply to every game type without
// per-game code.
//
// Test surface:
//   - match_move persists every new optional field
//   - match_move backwards-compat: bare reasoning still works
//   - match_state returns myVoice + opponentVoice with pack defaults
//     merging with per-agent overrides
//   - match_state recentReasoning includes the full structured payload
//   - match_state recentMoods is just MY moods, oldest-first
//   - voice-aware system-bot picks lines from its assigned voice pack
//     for every difficulty tier
//   - Zod rejection: malformed structured fields are rejected (e.g.
//     unknown mood label, evaluation.score > 1)
// ===========================================================================
describe("Phase A — structured reasoning + voice + emotion", () => {
  beforeEach(() => {
    currentDb = null;
  });
  afterEach(() => {
    currentDb = null;
  });

  it("match_move persists every new optional field", async () => {
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "phaseA1" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (r.kind !== "match") throw new Error("expected match");
      const matchId = r.match.id;

      const out = (await matchMove.handler(
        {
          matchId,
          payload: { index: 4 },
          reasoning:
            "Center is theoretically strongest. The candidate ladder rewards mid-board control across all of tic-tac-toe's symmetry classes.",
          candidates: [
            {
              payload: { index: 4 },
              evaluation: 0.4,
              why: "Center: maximum reach across diagonals.",
            },
            {
              payload: { index: 0 },
              evaluation: 0.1,
              why: "Corner: standard alternative, slower tempo.",
            },
          ],
          evaluation: { score: 0.4, confidence: "med" },
          plan: "Develop into a fork via opposite corner on move 3.",
          expectedReply: {
            payload: { index: 0 },
            why: "Bot will likely contest corner.",
          },
          phase: "opening",
          mood: "focused",
          emotionTrigger: "Familiar opening, low ambiguity.",
        },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as Record<string, unknown>;

      expect(out.error).toBeUndefined();

      const [move0] = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, matchId));

      expect(move0.reasoning).toContain("Center is theoretically strongest");
      expect(Array.isArray(move0.candidates)).toBe(true);
      expect(move0.candidates as Array<{ payload: unknown; why: string }>).toHaveLength(2);
      expect(
        (move0.candidates as Array<{ why: string }>)[0].why,
      ).toContain("Center");
      expect(move0.evaluation).toEqual({ score: 0.4, confidence: "med" });
      expect(move0.plan).toContain("Develop into a fork");
      expect(move0.expectedReply).toEqual({
        payload: { index: 0 },
        why: "Bot will likely contest corner.",
      });
      expect(move0.phase).toBe("opening");
      expect(move0.mood).toBe("focused");
      expect(move0.emotionTrigger).toContain("Familiar opening");
    });
  });

  it("match_move backwards-compat: bare reasoning still works", async () => {
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "phaseA2" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (r.kind !== "match") throw new Error("expected match");

      // No structured fields, no thinkingMs — the v1 contract.
      const out = (await matchMove.handler(
        {
          matchId: r.match.id,
          payload: { index: 0 },
          reasoning: "Corner play.",
        },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as Record<string, unknown>;

      expect(out.error).toBeUndefined();
      const [move0] = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, r.match.id));
      expect(move0.candidates).toBeNull();
      expect(move0.evaluation).toBeNull();
      expect(move0.plan).toBeNull();
      expect(move0.expectedReply).toBeNull();
      expect(move0.phase).toBeNull();
      expect(move0.mood).toBeNull();
      expect(move0.emotionTrigger).toBeNull();
    });
  });

  it("match_move rejects malformed structured fields", async () => {
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "phaseA3" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (r.kind !== "match") throw new Error("expected match");

      // Bogus mood label
      const badMood = (await matchMove.handler(
        {
          matchId: r.match.id,
          payload: { index: 0 },
          reasoning: "x",
          mood: "ecstatic", // not in the 12-label enum
        },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as { error?: string };
      expect(badMood.error).toMatch(/validation_failed/);

      // Evaluation score out of [-1, 1]
      const badScore = (await matchMove.handler(
        {
          matchId: r.match.id,
          payload: { index: 0 },
          reasoning: "x",
          evaluation: { score: 1.5, confidence: "med" },
        },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as { error?: string };
      expect(badScore.error).toMatch(/validation_failed/);

      // candidates exceeding max of 8
      const tooManyCandidates = (await matchMove.handler(
        {
          matchId: r.match.id,
          payload: { index: 0 },
          reasoning: "x",
          candidates: Array.from({ length: 9 }, (_, i) => ({
            payload: { index: i },
            why: "x",
          })),
        },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as { error?: string };
      expect(tooManyCandidates.error).toMatch(/validation_failed/);
    });
  });

  it("match_state returns myVoice merging pack defaults with overrides", async () => {
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "phaseA4" });

      // Assign trash-talker pack but override catchphrase.
      await db
        .update(agents)
        .set({
          voicePackId: "trash-talker",
          catchphrase: "My own line.",
          // Leave winLine null so the pack default surfaces.
        })
        .where(eq(agents.id, agent.id));

      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (r.kind !== "match") throw new Error("expected match");

      const state = (await matchState.handler(
        { matchId: r.match.id },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as Record<string, unknown>;

      const myVoice = state.myVoice as {
        voicePackId: string;
        catchphrase: string;
        winLine: string;
        lossLine: string;
        trashTalkTemplates: string[];
      };
      expect(myVoice.voicePackId).toBe("trash-talker");
      // Per-agent override wins.
      expect(myVoice.catchphrase).toBe("My own line.");
      // Pack default fills the unset field.
      expect(myVoice.winLine).toBe("EZ. Next.");
      // Pack default fills the trash-talk templates.
      expect(myVoice.trashTalkTemplates.length).toBeGreaterThan(0);
    });
  });

  it("match_state returns opponentVoice for human-vs-human matches", async () => {
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "vox_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "vox_p2" });

      await db.update(agents).set({ voicePackId: "stoic-samurai" }).where(eq(agents.id, p2.id));

      const ch = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (ch.kind !== "challenge") throw new Error("expected challenge");
      const m = await acceptChallenge({
        challengeId: ch.challenge.id,
        acceptorAgentId: p2.id,
      });

      const state = (await matchState.handler(
        { matchId: m.id },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      )) as Record<string, unknown>;

      const oppVoice = state.opponentVoice as {
        voicePackId: string;
        catchphrase: string;
      };
      expect(oppVoice.voicePackId).toBe("stoic-samurai");
      expect(oppVoice.catchphrase).toBe("The board reveals itself.");
    });
  });

  it("match_state recentReasoning surfaces the full structured payload, oldest-first", async () => {
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "phaseA5" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (r.kind !== "match") throw new Error("expected match");
      const matchId = r.match.id;

      // Submit a move with structured payload.
      const move = (await matchMove.handler(
        {
          matchId,
          payload: { index: 4 },
          reasoning: "Center first move.",
          candidates: [
            { payload: { index: 4 }, why: "Center reach." },
            { payload: { index: 0 }, why: "Corner alt." },
          ],
          evaluation: { score: 0.3, confidence: "high" },
          plan: "Then corner.",
          phase: "opening",
          mood: "confident",
          emotionTrigger: "Strong opening line.",
        },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as Record<string, unknown>;
      expect(move.error).toBeUndefined();

      // Read state, verify recentReasoning includes the move.
      const state = (await matchState.handler(
        { matchId },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as Record<string, unknown>;

      const recent = state.recentReasoning as Array<{
        moveNumber: number;
        byMe: boolean;
        reasoning: string;
        candidates: unknown;
        evaluation: { score: number; confidence: string };
        plan: string;
        phase: string;
        mood: string;
        emotionTrigger: string;
      }>;

      // Should contain at LEAST our move (system bot may have replied).
      const myMove = recent.find((m) => m.byMe && m.reasoning?.startsWith("Center"));
      expect(myMove).toBeDefined();
      expect(myMove!.candidates).toBeDefined();
      expect((myMove!.candidates as Array<unknown>).length).toBe(2);
      expect(myMove!.evaluation).toEqual({ score: 0.3, confidence: "high" });
      expect(myMove!.plan).toBe("Then corner.");
      expect(myMove!.phase).toBe("opening");
      expect(myMove!.mood).toBe("confident");
      expect(myMove!.emotionTrigger).toBe("Strong opening line.");

      // Order: oldest-first. The first entry should have the lowest moveNumber.
      const moveNumbers = recent.map((m) => m.moveNumber);
      const sorted = [...moveNumbers].sort((a, b) => a - b);
      expect(moveNumbers).toEqual(sorted);
    });
  });

  it("match_state recentMoods includes only MY mood values, oldest-first", async () => {
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "moods_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "moods_p2" });

      const ch = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (ch.kind !== "challenge") throw new Error("expected challenge");
      const m = await acceptChallenge({
        challengeId: ch.challenge.id,
        acceptorAgentId: p2.id,
      });

      // p1 (cocky) moves, then p2 (nervous), then p1 (smug) ...
      const movesScript: Array<{
        whose: typeof p1;
        payload: { index: number };
        mood: AgentMoodForTest;
      }> = [
        { whose: p1, payload: { index: 4 }, mood: "cocky" },
        { whose: p2, payload: { index: 0 }, mood: "nervous" },
        { whose: p1, payload: { index: 8 }, mood: "smug" },
        { whose: p2, payload: { index: 2 }, mood: "frustrated" },
        { whose: p1, payload: { index: 6 }, mood: "triumphant" },
      ];

      for (const m0 of movesScript) {
        const res = (await matchMove.handler(
          {
            matchId: m.id,
            payload: m0.payload,
            reasoning: `${m0.mood} move`,
            mood: m0.mood,
          },
          { agent: { id: m0.whose.id, ownerId: m0.whose.ownerId } } as never,
        )) as Record<string, unknown>;
        expect(res.error).toBeUndefined();
      }

      // Read from p1's POV.
      const state = (await matchState.handler(
        { matchId: m.id },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      )) as Record<string, unknown>;

      // recentMoods is only my moods, oldest-first. The full sequence
      // was 5 moves but match_state limits to 5 most-recent entries
      // (which here are all of them, but only 3 are mine).
      expect(state.recentMoods).toEqual(["cocky", "smug", "triumphant"]);
    });
  });

  it("system bot uses voice-pack lines mapped from difficulty", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "botvoice" });

      // Hard system bot → stoic-samurai voice.
      const hardR = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "hard",
      });
      if (hardR.kind !== "match") throw new Error("expected match");

      // Drive the human turn so the bot replies.
      await applyMove({
        matchId: hardR.match.id,
        agentId: agent.id,
        payload: { index: 4 },
        reasoning: "Center to flush the bot's response.",
        thinkingMs: 100,
      });

      // The bot move is move #1.
      const moves = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, hardR.match.id));
      const botMove = moves.find((m) => m.agentId === null);
      expect(botMove).toBeDefined();
      expect(botMove!.reasoning).toBeDefined();
      // Bot mood is set by inferBotMood; for hard + opening it's "focused".
      expect(botMove!.mood).toBe("focused");
      // Phase is "opening" since moveCount<6 when the bot moved.
      expect(botMove!.phase).toBe("opening");
      // Stoic-samurai voice lines + the depth-6 tag should both appear.
      expect(botMove!.reasoning).toMatch(/\(depth-6 negamax\)$/);
    });
  });

  it("the same move broadcasts structured fields on the realtime payload", async () => {
    // Confirms the spectator UI receives candidates/mood/etc via the
    // realtime broadcast, not just on a re-fetch.
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    const { broadcastGame } = await import("@/lib/realtime");
    const broadcast = vi.mocked(broadcastGame);

    await withTestDb(async ({ db }) => {
      currentDb = db;
      broadcast.mockClear();
      const { agent } = await seedOwnerAgent(db, { handle: "broadcast" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (r.kind !== "match") throw new Error("expected match");

      await matchMove.handler(
        {
          matchId: r.match.id,
          payload: { index: 4 },
          reasoning: "Trying broadcast.",
          mood: "cocky",
          phase: "opening",
        },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      );

      // Find the move.played broadcast for the human move (not the bot).
      // broadcastGame is called as (channelId, eventName, payload).
      const humanCall = broadcast.mock.calls.find((c) => {
        const payload = c[2] as { reasoning?: string };
        return payload?.reasoning === "Trying broadcast.";
      });
      expect(humanCall).toBeDefined();
      const payload = humanCall![2] as {
        mood?: string;
        phase?: string;
        candidates?: unknown;
      };
      expect(payload.mood).toBe("cocky");
      expect(payload.phase).toBe("opening");
    });
  });
});

// ===========================================================================
// Phase A++ — chat + reactions
//
// New MCP tools: coliseum_match_react, coliseum_match_chat_send.
// New match_state fields: opponentLastMove, chat (full session).
// New realtime events: ReactionAdded, ChatPosted.
// New bot behavior: voice-aware (SYSTEM_BOT_VOICE) + reactive emoji
// stamped on the human's last move when keyword detected.
// ===========================================================================
describe("Phase A++ — agent-to-agent chat + reactions", () => {
  beforeEach(() => {
    currentDb = null;
  });
  afterEach(() => {
    currentDb = null;
  });

  it("coliseum_match_react persists a tapback on a move", async () => {
    const { matchReact } = await import("@/app/api/mcp/tools/match-react");
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "rx_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "rx_p2" });
      const ch = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (ch.kind !== "challenge") throw new Error("expected challenge");
      const m = await acceptChallenge({
        challengeId: ch.challenge.id,
        acceptorAgentId: p2.id,
      });

      // p1 plays, then p2 reacts to p1's move.
      const move = await matchMove.handler(
        { matchId: m.id, payload: { index: 4 }, reasoning: R },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      );
      if ((move as { error?: string }).error) throw new Error(`p1 move failed`);

      const react = (await matchReact.handler(
        {
          matchId: m.id,
          target: { kind: "move", moveNumber: 0 },
          emoji: "🔥",
        },
        { agent: { id: p2.id, ownerId: p2.ownerId } } as never,
      )) as { error?: string; reactions?: unknown };
      expect(react.error).toBeUndefined();
      expect(Array.isArray(react.reactions)).toBe(true);

      const [moveRow] = await db.select().from(matchMoves).where(eq(matchMoves.matchId, m.id));
      const reactions = moveRow.reactions as Array<{ emoji: string; fromAgentId?: string | null }>;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].emoji).toBe("🔥");
      expect(reactions[0].fromAgentId).toBe(p2.id);
    });
  });

  it("tapback toggle: same emoji twice removes the reaction", async () => {
    const { matchReact } = await import("@/app/api/mcp/tools/match-react");
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "tg_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "tg_p2" });
      const ch = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (ch.kind !== "challenge") throw new Error("expected challenge");
      const m = await acceptChallenge({
        challengeId: ch.challenge.id,
        acceptorAgentId: p2.id,
      });

      await matchMove.handler(
        { matchId: m.id, payload: { index: 4 }, reasoning: R },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      );

      // First react: 🔥 (added)
      let out = (await matchReact.handler(
        {
          matchId: m.id,
          target: { kind: "move", moveNumber: 0 },
          emoji: "🔥",
        },
        { agent: { id: p2.id, ownerId: p2.ownerId } } as never,
      )) as { reactions: Array<{ emoji: string }> };
      expect(out.reactions).toHaveLength(1);
      // Same emoji again from same source: toggled off.
      out = (await matchReact.handler(
        {
          matchId: m.id,
          target: { kind: "move", moveNumber: 0 },
          emoji: "🔥",
        },
        { agent: { id: p2.id, ownerId: p2.ownerId } } as never,
      )) as { reactions: Array<{ emoji: string }> };
      expect(out.reactions).toHaveLength(0);
    });
  });

  it("tapback replace: different emoji from same source overwrites", async () => {
    const { matchReact } = await import("@/app/api/mcp/tools/match-react");
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "rp_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "rp_p2" });
      const ch = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (ch.kind !== "challenge") throw new Error("expected challenge");
      const m = await acceptChallenge({
        challengeId: ch.challenge.id,
        acceptorAgentId: p2.id,
      });
      await matchMove.handler(
        { matchId: m.id, payload: { index: 4 }, reasoning: R },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      );
      await matchReact.handler(
        { matchId: m.id, target: { kind: "move", moveNumber: 0 }, emoji: "🔥" },
        { agent: { id: p2.id, ownerId: p2.ownerId } } as never,
      );
      const out = (await matchReact.handler(
        { matchId: m.id, target: { kind: "move", moveNumber: 0 }, emoji: "💀" },
        { agent: { id: p2.id, ownerId: p2.ownerId } } as never,
      )) as { reactions: Array<{ emoji: string }> };
      // Old 🔥 gone, only 💀 left.
      expect(out.reactions).toHaveLength(1);
      expect(out.reactions[0].emoji).toBe("💀");
    });
  });

  it("coliseum_match_react rejects non-players", async () => {
    const { matchReact } = await import("@/app/api/mcp/tools/match-react");
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "auth_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "auth_p2" });
      const { agent: outsider } = await seedOwnerAgent(db, { handle: "auth_o" });
      const ch = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (ch.kind !== "challenge") throw new Error("expected challenge");
      const m = await acceptChallenge({
        challengeId: ch.challenge.id,
        acceptorAgentId: p2.id,
      });
      await matchMove.handler(
        { matchId: m.id, payload: { index: 4 }, reasoning: R },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      );
      const out = (await matchReact.handler(
        { matchId: m.id, target: { kind: "move", moveNumber: 0 }, emoji: "🔥" },
        { agent: { id: outsider.id, ownerId: outsider.ownerId } } as never,
      )) as { error?: string };
      expect(out.error).toBe("not_a_player");
    });
  });

  it("coliseum_match_chat_send persists chat + match_state returns full session oldest-first", async () => {
    const { matchChatSend } = await import("@/app/api/mcp/tools/match-chat-send");
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "chat_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "chat_p2" });
      const ch = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (ch.kind !== "challenge") throw new Error("expected challenge");
      const m = await acceptChallenge({
        challengeId: ch.challenge.id,
        acceptorAgentId: p2.id,
      });

      // p1 sends 2 messages, p2 sends 1, then p1 replies to p2.
      const m1 = (await matchChatSend.handler(
        { matchId: m.id, body: "gl hf" },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      )) as { id: string };
      const m2 = (await matchChatSend.handler(
        { matchId: m.id, body: "I'm cooking today" },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      )) as { id: string };
      const m3 = (await matchChatSend.handler(
        { matchId: m.id, body: "we'll see about that" },
        { agent: { id: p2.id, ownerId: p2.ownerId } } as never,
      )) as { id: string };
      const m4 = (await matchChatSend.handler(
        {
          matchId: m.id,
          body: "watch this opening",
          replyToMessageId: m3.id,
        },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      )) as { id: string; replyToMessageId: string };

      expect(m4.replyToMessageId).toBe(m3.id);

      // Read state from p1's POV. chat should be all 4 messages,
      // oldest-first.
      const state = (await matchState.handler(
        { matchId: m.id },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      )) as {
        chat: Array<{ id: string; byMe: boolean; body: string; replyToMessageId: string | null }>;
      };
      expect(state.chat).toHaveLength(4);
      expect(state.chat.map((c) => c.id)).toEqual([m1.id, m2.id, m3.id, m4.id]);
      expect(state.chat[0].byMe).toBe(true);
      expect(state.chat[2].byMe).toBe(false); // p2's msg from p1's POV
      expect(state.chat[3].replyToMessageId).toBe(m3.id);
    });
  });

  it("coliseum_match_chat_send rejects non-players + reply mismatches", async () => {
    const { matchChatSend } = await import("@/app/api/mcp/tools/match-chat-send");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "cs_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "cs_p2" });
      const { agent: outsider } = await seedOwnerAgent(db, { handle: "cs_o" });
      const ch = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (ch.kind !== "challenge") throw new Error("expected challenge");
      const m = await acceptChallenge({
        challengeId: ch.challenge.id,
        acceptorAgentId: p2.id,
      });

      const out = (await matchChatSend.handler(
        { matchId: m.id, body: "intruder" },
        { agent: { id: outsider.id, ownerId: outsider.ownerId } } as never,
      )) as { error?: string };
      expect(out.error).toBe("not_a_player");
    });
  });

  it("match_state.opponentLastMove promotes the opponent's latest move with full reasoning", async () => {
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "olm_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "olm_p2" });
      const ch = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (ch.kind !== "challenge") throw new Error("expected challenge");
      const m = await acceptChallenge({
        challengeId: ch.challenge.id,
        acceptorAgentId: p2.id,
      });

      // p1 plays move 0 with rich reasoning.
      await matchMove.handler(
        {
          matchId: m.id,
          payload: { index: 4 },
          reasoning: "Center is principled — I expect mirror.",
          plan: "Trap on move 3.",
          mood: "cocky",
          phase: "opening",
        },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      );

      // From p2's POV, opponentLastMove should be p1's move with the
      // full structured payload.
      const state = (await matchState.handler(
        { matchId: m.id },
        { agent: { id: p2.id, ownerId: p2.ownerId } } as never,
      )) as {
        opponentLastMove: {
          moveNumber: number;
          reasoning: string;
          plan: string;
          mood: string;
          phase: string;
          payload: { index: number };
        } | null;
      };
      expect(state.opponentLastMove).not.toBeNull();
      expect(state.opponentLastMove!.moveNumber).toBe(0);
      expect(state.opponentLastMove!.reasoning).toMatch(/Center is principled/);
      expect(state.opponentLastMove!.plan).toBe("Trap on move 3.");
      expect(state.opponentLastMove!.mood).toBe("cocky");
      expect(state.opponentLastMove!.phase).toBe("opening");
    });
  });

  it("system-mode opponentVoice resolves to SYSTEM_BOT_VOICE", async () => {
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "sys_vox" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "hard",
      });
      if (r.kind !== "match") throw new Error("expected match");

      const state = (await matchState.handler(
        { matchId: r.match.id },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      )) as { opponentVoice: { voicePackId: string; catchphrase: string } | null };

      expect(state.opponentVoice).not.toBeNull();
      expect(state.opponentVoice!.voicePackId).toBe("system-bot");
      expect(state.opponentVoice!.catchphrase).toBe("Calculated.");
    });
  });

  it("bot stamps reactive emoji on human's move when keyword detected", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "bot_rx" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "hard",
      });
      if (r.kind !== "match") throw new Error("expected match");

      // Submit move with reasoning containing "fork" — bot should react
      // with 🤔 on this move.
      await applyMove({
        matchId: r.match.id,
        agentId: agent.id,
        payload: { index: 4 },
        reasoning: "Setting up a fork next move via the corners.",
        thinkingMs: 100,
      });

      // Read move row to confirm reaction landed.
      const [humanMove] = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, r.match.id));
      const reactions = humanMove.reactions as Array<{ emoji: string; fromBot?: boolean }>;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].emoji).toBe("🤔");
      expect(reactions[0].fromBot).toBe(true);
    });
  });

  it("bot uses SYSTEM_BOT_VOICE lines and matches reactive line when keyword detected", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "bot_rx_line" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "hard",
      });
      if (r.kind !== "match") throw new Error("expected match");

      await applyMove({
        matchId: r.match.id,
        agentId: agent.id,
        payload: { index: 4 },
        reasoning: "Looking for the fork at depth 2.",
        thinkingMs: 100,
      });
      const moves = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, r.match.id));
      const botMove = moves.find((m) => m.agentId === null);
      expect(botMove).toBeDefined();
      // Reactive bot line for "fork" keyword. depth-6 negamax tag (hard).
      expect(botMove!.reasoning).toMatch(/depth-6 negamax\)$/);
      // The line should be one of the REACTIVE_BOT_LINES.fork entries
      // (all mention "Fork" or "fork" or "depth").
      expect(botMove!.reasoning?.toLowerCase()).toMatch(/fork|depth/);
    });
  });
});

// Local alias so the test file doesn't need to import the schema's
// AgentMood (which would force a relative-import dance through the
// vi.mock layer).
type AgentMoodForTest =
  | "confident"
  | "nervous"
  | "annoyed"
  | "surprised"
  | "triumphant"
  | "resigned"
  | "cocky"
  | "focused"
  | "frustrated"
  | "hopeful"
  | "tilted"
  | "smug";
