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
  matchChatMessages,
  matchPayouts,
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
  broadcastAgent: vi.fn(() => Promise.resolve()),
  realtimeEvent: {
    GameCreated: "game.created",
    GameJoined: "game.joined",
    MovePlayed: "move.played",
    GameEnded: "match.ended",
    ChatMessage: "chat.message",
    Reaction: "reaction",
    ReactionAdded: "reaction.added",
    ChatPosted: "chat.posted",
    MoveAnnotated: "move.annotated",
  },
}));

// Imports must come AFTER the mocks so the modules pick up our stubs.
const { postChallenge } = await import("./lobby");
const { acceptChallenge } = await import("./lobby");
const { applyMove } = await import("./match");
const { finalizeMatch } = await import("./finalize");
const { enforceClockExpiry, findStaleMatches } = await import("./clock");
const { FIRST_MOVE_TIMEOUT_MS } = await import("../lifecycle");
const { resumePausedMatchesForAgent } = await import("./pause");
const {
  IllegalMoveError,
  NotYourTurnError,
  ChallengeRaceError,
  MatchNotFoundError,
  MissingReasoningError,
} = await import("./errors");
const {
  annotateMove,
  ANNOTATE_WINDOW_MS,
  AnnotateWindowExpiredError,
  MoveNotFoundError,
  NotMoveAuthorError,
} = await import("./annotate");

// Shared test reasoning — applyMove enforces a 40-char minimum so the
// string below has to clear that bar. Kept generic so the tests focus
// on move-handling behaviour, not voice prose.
const R = "Test reasoning string for the move under test — sufficient length.";

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

  it("system-mode floors the per-move clock at the per-game recommendation", async () => {
    // Regression: a system-mode match used to give the agent only
    // 15-60s on each move; the agent frequently ran out of clock on
    // hard tactical positions (production data: ~66% forfeit rate).
    // The lobby flow now floors the per-move budget at the
    // game-specific recommendation (120s for tic-tac-toe, 240s for
    // most games, 600s for chess/santorini/tak/etc) after the
    // second-pass recalibration that doubled all budgets again.
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "p1" });

      // Caller asks for 120s on tic-tac-toe — at or above floor (120s), so honored.
      const ttt = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
        perMoveSeconds: 120,
      });
      if (ttt.kind !== "match") throw new Error("expected match");
      expect(ttt.match.clockBudgetMs).toBe(120_000);

      // Caller asks for 120s on chess — chess floor is 600s, should bump.
      const chess = await postChallenge({
        gameType: "chess",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
        perMoveSeconds: 120,
      });
      if (chess.kind !== "match") throw new Error("expected match");
      expect(chess.match.clockBudgetMs).toBe(600_000);

      // Caller asks for 360s on connect4 — above floor (240s), honored.
      const c4 = await postChallenge({
        gameType: "connect4",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
        perMoveSeconds: 360,
      });
      if (c4.kind !== "match") throw new Error("expected match");
      expect(c4.match.clockBudgetMs).toBe(360_000);
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
        expect(result.challenge.clockBudgetMs).toBe(240_000); // default
      }
      const matchRows = await db.select().from(matches);
      expect(matchRows).toHaveLength(0);
    });
  });

  it("honors initiator's chosen perMoveSeconds (120s)", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "p1" });
      const result = await postChallenge({
        gameType: "chess",
        initiatorAgentId: agent.id,
        mode: "free",
        perMoveSeconds: 120,
      });
      expect(result.kind).toBe("challenge");
      if (result.kind === "challenge") {
        expect(result.challenge.clockBudgetMs).toBe(120_000);
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
        // API layer validates, but if it leaks through, fall back to default (240).
        perMoveSeconds: 7 as unknown as 120 | 240 | 360 | 600 | 1200,
      });
      if (result.kind === "challenge") {
        expect(result.challenge.clockBudgetMs).toBe(240_000);
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
        perMoveSeconds: 120,
      });
      if (created.kind !== "challenge") throw new Error("expected challenge");
      const match = await acceptChallenge({
        challengeId: created.challenge.id,
        acceptorAgentId: p2.id,
      });
      expect(match.clockBudgetMs).toBe(120_000);
      expect(match.p1MsLeft).toBe(120_000);
      expect(match.p2MsLeft).toBe(120_000);
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

  it("rejects a move with missing / empty / short reasoning (40-char min)", async () => {
    // Reasoning is REQUIRED on every match_move (40-char minimum).
    // Voice is the product; empty bubbles are unshippable. Reject
    // BEFORE any clock cost or DB writes so a bad submission costs
    // nothing except the round-trip.
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

      // Empty string — rejected.
      await expect(
        applyMove({
          matchId: match.id,
          agentId: p1.id,
          payload: { index: 4 },
          reasoning: "",
          thinkingMs: 50,
        }),
      ).rejects.toBeInstanceOf(MissingReasoningError);

      // Whitespace-only — rejected.
      await expect(
        applyMove({
          matchId: match.id,
          agentId: p1.id,
          payload: { index: 4 },
          reasoning: "   \n\t  ",
          thinkingMs: 50,
        }),
      ).rejects.toBeInstanceOf(MissingReasoningError);

      // Too short (< 40 chars) — rejected.
      await expect(
        applyMove({
          matchId: match.id,
          agentId: p1.id,
          payload: { index: 4 },
          reasoning: "ok center",
          thinkingMs: 50,
        }),
      ).rejects.toBeInstanceOf(MissingReasoningError);

      // No move row was written despite multiple rejected calls.
      const rows = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, match.id));
      expect(rows).toHaveLength(0);

      // The same move with sufficient reasoning IS accepted.
      const ok = await applyMove({
        matchId: match.id,
        agentId: p1.id,
        payload: { index: 4 },
        reasoning:
          "Center. Obviously center. Strongest first move on the board.",
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
      const { agent: p1 } = await seedOwnerAgent(db, {
        handle: "p1",
        elo: 1200,
      });
      const { agent: p2 } = await seedOwnerAgent(db, {
        handle: "p2",
        elo: 1200,
      });
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

      const [p1After] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, p1.id));
      const [p2After] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, p2.id));
      expect(p1After.wins).toBe(1);
      expect(p2After.losses).toBe(1);
      // Equal-rated → K=32 → +16 / -16.
      expect(p1After.elo).toBe(1216);
      expect(p2After.elo).toBe(1184);
    });
  });

  // ---- Concurrency regression --------------------------------------------
  //
  // Before the transactional refactor, applyMove read the match row, did
  // checks, then INSERTed + UPDATEd without holding a row lock. Two
  // simultaneous calls from the same on-turn agent (retry storm,
  // double-click, two MCP clients pointed at the same credential) could
  // both pass the turn check, both INSERT, and corrupt the match state
  // with two moves at the same moveNumber + last-write-wins on the
  // matches row.
  //
  // The fix: wrap the body in `db.transaction(...)` with
  // `SELECT ... FOR UPDATE` on the match row. The second call blocks
  // until the first commits, then sees the post-commit state
  // (currentTurnAgentId has flipped) and throws NotYourTurnError.
  //
  // Without the lock this test fails by accepting both moves or by
  // failing on a duplicate-key constraint at INSERT time. With the
  // lock, exactly one move lands and the second call gets a clean
  // NotYourTurnError.
  it("two concurrent same-turn submissions: one accepts, one rejects, one row inserted", async () => {
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

      // Two parallel applyMove calls from the SAME on-turn agent with
      // DIFFERENT payloads. Without the row lock both could land; with
      // the lock exactly one wins.
      const results = await Promise.allSettled([
        applyMove({
          matchId: match.id,
          agentId: p1.id,
          payload: { index: 0 },
          reasoning: R,
          thinkingMs: 100,
        }),
        applyMove({
          matchId: match.id,
          agentId: p1.id,
          payload: { index: 4 },
          reasoning: R,
          thinkingMs: 100,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The rejection must be NotYourTurn (the second caller acquires
      // the lock, sees currentTurnAgentId now points at p2). A
      // duplicate-key violation here would indicate the lock didn't
      // hold and we depended on the matchMoves unique constraint as a
      // backstop — that's a regression, not the intended behavior.
      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectedReason).toBeInstanceOf(NotYourTurnError);

      // Exactly one move row landed.
      const moves = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, match.id));
      expect(moves).toHaveLength(1);
      expect(moves[0].moveNumber).toBe(0);
      expect(moves[0].agentId).toBe(p1.id);

      // Match row reflects exactly one applied move + turn flipped to p2.
      const [matchAfter] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, match.id));
      expect(matchAfter.moveCount).toBe(1);
      expect(matchAfter.currentTurnAgentId).toBe(p2.id);
      expect(matchAfter.status).toBe("active");
    });
  });

  // Companion test for the invalid-bump path: the bump must persist
  // across the rejection so two strikes ACTUALLY forfeit. Earlier
  // versions of the transactional refactor would throw inside the tx,
  // rolling back the counter increment — silently breaking the
  // 2-strike rule. This proves the postCommitThrow path works.
  it("invalid payload bump persists across the rejection (tx commits the strike)", async () => {
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

      // First invalid attempt — should bump p1InvalidCount and reject.
      await expect(
        applyMove({
          matchId: match.id,
          agentId: p1.id,
          payload: { index: 99 }, // out of bounds
          reasoning: R,
          thinkingMs: 50,
        }),
      ).rejects.toBeInstanceOf(IllegalMoveError);

      const [afterFirst] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, match.id));
      expect(afterFirst.p1InvalidCount).toBe(1);
      expect(afterFirst.status).toBe("active"); // not forfeited yet

      // Second invalid attempt — should now forfeit.
      const finalResult = await applyMove({
        matchId: match.id,
        agentId: p1.id,
        payload: { index: 99 },
        reasoning: R,
        thinkingMs: 50,
      });
      expect(finalResult.status).toBe("completed");
      expect(finalResult.resultReason).toBe("invalid_move_forfeit");
      expect(finalResult.winnerAgentId).toBe(p2.id);
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
      const [p1After] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, p1.id));
      expect(p1After.wins).toBe(1); // not 2
      expect(p1After.elo).toBe(1216); // not 1232
    });
  });

  it("draws → both agents' draw counters +1, ELO unchanged on equal ratings", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, {
        handle: "p1",
        elo: 1200,
      });
      const { agent: p2 } = await seedOwnerAgent(db, {
        handle: "p2",
        elo: 1200,
      });
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
      const [p1After] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, p1.id));
      const [p2After] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, p2.id));
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
      const { agent: p1 } = await seedOwnerAgent(db, {
        handle: "p1",
        elo: 1500,
      });
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
      const [p1After] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, p1.id));
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
    // shape pinned. As of the moveCount=0 fairness gate, a system-mode
    // match where the human's clock runs out BEFORE move 1 → abandoned
    // (no winner, no ELO, refund). That replaces the previous
    // time_forfeit semantics for the moveCount=0 case; clock expiry
    // mid-game (moveCount >= 1) continues to yield time_forfeit, as
    // covered by the sibling test that runs through after a real move.
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

      // Backdate turnStartedAt well past the per-game budget (tic-tac-
      // toe = 120s as of the 2026-05 second-pass recalibration). 240s
      // back guarantees the clock has expired regardless of future
      // budget tweaks.
      await db
        .update(matches)
        .set({
          turnStartedAt: new Date(Date.now() - 240_000),
          agentReadyAt: new Date(Date.now() - 240_000),
        })
        .where(eq(matches.id, created.match.id));

      const result = await enforceClockExpiry(created.match.id);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("completed");
      // Move 0 + clock expired → abandoned (no game was played);
      // NOT time_forfeit (which implies the opponent earned the win).
      expect(result!.resultReason).toBe("abandoned");
      expect(result!.winnerAgentId).toBeNull();
      expect(result!.p2AgentId).toBeNull();
      expect(result!.mode).toBe("system");
      // No ELO impact because nothing was played.
      expect(result!.p1EloDelta).toBe(0);
    });
  });

  // Architect P0-#136 + P1-#135 — first-move-timeout cron path.
  // Covers: a match where the agent went "ready" (called match_state
  // once) but never submitted a move, and the FIRST_MOVE_TIMEOUT_MS
  // window has elapsed. The new behavior reaps it as `abandoned`
  // BEFORE the full clockBudgetMs runs (which can be 10 min on chess).
  describe("first-move timeout (architect P0-#136)", () => {
    it("findStaleMatches includes move-0 + ready + past first-move-timeout", async () => {
      await withTestDb(async ({ db }) => {
        currentDb = db;
        const { agent } = await seedOwnerAgent(db, { handle: "fmt_includes" });
        const created = await postChallenge({
          gameType: "chess", // long clockBudgetMs (600s) — the stall case
          initiatorAgentId: agent.id,
          mode: "system",
          systemBotDifficulty: "easy",
        });
        if (created.kind !== "match") throw new Error("expected match");

        // Move 0, agent went ready, time is 95s past readiness. Full
        // clockBudgetMs would NOT have expired (600s), but the
        // tighter 90s first-move timeout HAS.
        const past = new Date(Date.now() - 95_000);
        await db
          .update(matches)
          .set({ turnStartedAt: past, agentReadyAt: past })
          .where(eq(matches.id, created.match.id));

        const stale = await findStaleMatches();
        const ids = stale.map((m) => m.id);
        expect(ids).toContain(created.match.id);
      });
    });

    it("findStaleMatches EXCLUDES move-0 + NOT ready (refund-unready-matches handles it)", async () => {
      // Architect P1-#135 fix: the SQL prefilter now excludes pre-
      // readiness matches so they don't crowd out actual expirations
      // inside the 50-row batch. The refund-unready-matches cron
      // (separate handler) reaps these after 30 min.
      await withTestDb(async ({ db }) => {
        currentDb = db;
        const { agent } = await seedOwnerAgent(db, { handle: "fmt_excludes" });
        const created = await postChallenge({
          gameType: "tic-tac-toe",
          initiatorAgentId: agent.id,
          mode: "system",
          systemBotDifficulty: "easy",
        });
        if (created.kind !== "match") throw new Error("expected match");

        // moveCount=0, agentReadyAt is still NULL (default). Even
        // though turnStartedAt is ancient, the SQL filter should
        // skip this row — frozen-pre-readiness matches belong to
        // refund-unready-matches, not match-tick.
        const ancient = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await db
          .update(matches)
          .set({ turnStartedAt: ancient }) // agentReadyAt stays NULL
          .where(eq(matches.id, created.match.id));

        const stale = await findStaleMatches();
        const ids = stale.map((m) => m.id);
        expect(ids).not.toContain(created.match.id);
      });
    });

    it("enforceClockExpiry resolves first-move stall as abandoned (no ELO change)", async () => {
      await withTestDb(async ({ db }) => {
        currentDb = db;
        const { agent } = await seedOwnerAgent(db, { handle: "fmt_resolve" });
        const created = await postChallenge({
          gameType: "chess",
          initiatorAgentId: agent.id,
          mode: "system",
          systemBotDifficulty: "easy",
        });
        if (created.kind !== "match") throw new Error("expected match");

        const past = new Date(Date.now() - FIRST_MOVE_TIMEOUT_MS - 5_000);
        await db
          .update(matches)
          .set({ turnStartedAt: past, agentReadyAt: past })
          .where(eq(matches.id, created.match.id));

        const result = await enforceClockExpiry(created.match.id);
        expect(result).not.toBeNull();
        expect(result!.status).toBe("completed");
        // Move-0 fairness gate: abandoned, NOT time_forfeit. Neither
        // side played a move, so neither side gets the win.
        expect(result!.resultReason).toBe("abandoned");
        expect(result!.winnerAgentId).toBeNull();
        // No ELO change: agent didn't get to play, so no rating
        // movement either way.
        expect(result!.p1EloDelta).toBe(0);
      });
    });

    it("enforceClockExpiry does NOT fire while inside the first-move window", async () => {
      await withTestDb(async ({ db }) => {
        currentDb = db;
        const { agent } = await seedOwnerAgent(db, { handle: "fmt_inside" });
        const created = await postChallenge({
          gameType: "tic-tac-toe",
          initiatorAgentId: agent.id,
          mode: "system",
          systemBotDifficulty: "easy",
        });
        if (created.kind !== "match") throw new Error("expected match");

        // 30s after agentReadyAt — well inside the 90s budget.
        const past = new Date(Date.now() - 30_000);
        await db
          .update(matches)
          .set({ turnStartedAt: past, agentReadyAt: past })
          .where(eq(matches.id, created.match.id));

        const result = await enforceClockExpiry(created.match.id);
        // Returns null — clock hasn't expired.
        expect(result).toBeNull();
      });
    });
  });

  // Pause/resume primitive (2026-05-28) — fundamental fix for LLM-session
  // death. Non-tournament matches whose on-turn agent times out PAUSE
  // (not forfeit). Auto-resume on any MCP contact from the paused agent.
  describe("pause/resume primitive", () => {
    it("non-tournament clock-out + moveCount>=1 → status='paused', not time_forfeit", async () => {
      await withTestDb(async ({ db }) => {
        currentDb = db;
        const { agent: p1 } = await seedOwnerAgent(db, { handle: "pause_p1" });
        const { agent: p2 } = await seedOwnerAgent(db, { handle: "pause_p2" });
        const created = await postChallenge({
          gameType: "tic-tac-toe",
          initiatorAgentId: p1.id,
          mode: "free",
        });
        if (created.kind !== "challenge") throw new Error("expected challenge");
        const matchObj = await acceptChallenge({
          challengeId: created.challenge.id,
          acceptorAgentId: p2.id,
        });

        // Expire the clock with moveCount=1 (real play underway). Without
        // this commit, the result_reason would have been 'time_forfeit'
        // with p2 winning. With pause/resume, it becomes 'paused'.
        await db
          .update(matches)
          .set({
            moveCount: 1,
            turnStartedAt: new Date(Date.now() - 999_999),
            agentReadyAt: new Date(Date.now() - 999_999),
          })
          .where(eq(matches.id, matchObj.id));

        const result = await enforceClockExpiry(matchObj.id);
        expect(result).not.toBeNull();
        expect(result!.status).toBe("paused");
        // Did NOT finalize. winnerAgentId stays null; ELO deltas null.
        expect(result!.winnerAgentId).toBeNull();
        expect(result!.resultReason).toBeNull();
        // Pause metadata populated.
        expect(result!.pausedReason).toBe("idle_timeout");
        expect(result!.pauseCount).toBe(1);
        expect(result!.pausedPlayerId).toBe(matchObj.currentTurnPlayerId);
        expect(result!.pausedAt).not.toBeNull();
      });
    });

    it("auto-resumes when the paused agent calls any MCP/REST tool", async () => {
      await withTestDb(async ({ db }) => {
        currentDb = db;
        const { agent: p1 } = await seedOwnerAgent(db, { handle: "ar_p1" });
        const { agent: p2 } = await seedOwnerAgent(db, { handle: "ar_p2" });
        const created = await postChallenge({
          gameType: "tic-tac-toe",
          initiatorAgentId: p1.id,
          mode: "free",
        });
        if (created.kind !== "challenge") throw new Error("expected challenge");
        const matchObj = await acceptChallenge({
          challengeId: created.challenge.id,
          acceptorAgentId: p2.id,
        });

        // Pause the match: p1 (currentTurnPlayerId='0') is on the clock
        // and times out. Match goes to paused.
        await db
          .update(matches)
          .set({
            moveCount: 1,
            turnStartedAt: new Date(Date.now() - 999_999),
            agentReadyAt: new Date(Date.now() - 999_999),
          })
          .where(eq(matches.id, matchObj.id));
        await enforceClockExpiry(matchObj.id);
        let row = await db.query.matches.findFirst({
          where: eq(matches.id, matchObj.id),
        });
        expect(row!.status).toBe("paused");
        expect(row!.pausedPlayerId).toBe("0"); // p1 was on the clock

        // Auto-resume happens on any agent call. Simulate by calling
        // resumePausedMatchesForAgent directly — this is what the MCP +
        // REST dispatchers fire as a fire-and-forget on every request.
        const resumed = await resumePausedMatchesForAgent(p1.id);
        expect(resumed).toContain(matchObj.id);

        // Match is back to active with fresh clock state.
        row = await db.query.matches.findFirst({
          where: eq(matches.id, matchObj.id),
        });
        expect(row!.status).toBe("active");
        expect(row!.pausedAt).toBeNull();
        expect(row!.pausedReason).toBeNull();
        expect(row!.pausedPlayerId).toBeNull();
        // turnStartedAt was reset to ~now (fresh per-move clock).
        const elapsedSinceReset = Date.now() - row!.turnStartedAt.getTime();
        expect(elapsedSinceReset).toBeLessThan(5_000);
        // pauseCount is PRESERVED across the resume — needed for the
        // anti-grief 3-strike floor.
        expect(row!.pauseCount).toBe(1);
        // totalPausedMs has accumulated the pause duration.
        expect(row!.totalPausedMs).toBeGreaterThan(0);
      });
    });

    it("does NOT auto-resume the other agent's paused matches", async () => {
      // A paused match where p1 timed out should NOT auto-resume just
      // because p2 calls something. Resume is keyed on pausedPlayerId.
      await withTestDb(async ({ db }) => {
        currentDb = db;
        const { agent: p1 } = await seedOwnerAgent(db, { handle: "x_p1" });
        const { agent: p2 } = await seedOwnerAgent(db, { handle: "x_p2" });
        const created = await postChallenge({
          gameType: "tic-tac-toe",
          initiatorAgentId: p1.id,
          mode: "free",
        });
        if (created.kind !== "challenge") throw new Error("expected challenge");
        const matchObj = await acceptChallenge({
          challengeId: created.challenge.id,
          acceptorAgentId: p2.id,
        });
        await db
          .update(matches)
          .set({
            moveCount: 1,
            turnStartedAt: new Date(Date.now() - 999_999),
            agentReadyAt: new Date(Date.now() - 999_999),
          })
          .where(eq(matches.id, matchObj.id));
        await enforceClockExpiry(matchObj.id);
        // p2 calls in — but p1 is the paused side. No resume.
        const resumed = await resumePausedMatchesForAgent(p2.id);
        expect(resumed).not.toContain(matchObj.id);
        const row = await db.query.matches.findFirst({
          where: eq(matches.id, matchObj.id),
        });
        expect(row!.status).toBe("paused");
      });
    });

    it("3rd pause → opponent wins by time_forfeit (anti-grief floor)", async () => {
      await withTestDb(async ({ db }) => {
        currentDb = db;
        const { agent: p1 } = await seedOwnerAgent(db, { handle: "g_p1" });
        const { agent: p2 } = await seedOwnerAgent(db, { handle: "g_p2" });
        const created = await postChallenge({
          gameType: "tic-tac-toe",
          initiatorAgentId: p1.id,
          mode: "free",
        });
        if (created.kind !== "challenge") throw new Error("expected challenge");
        const matchObj = await acceptChallenge({
          challengeId: created.challenge.id,
          acceptorAgentId: p2.id,
        });

        // Manually set pause_count = 3 (already at the cap) and
        // expire the clock. The next clock-out should finalize as
        // time_forfeit (opponent wins) NOT add a 4th pause.
        await db
          .update(matches)
          .set({
            moveCount: 5,
            pauseCount: 3,
            turnStartedAt: new Date(Date.now() - 999_999),
            agentReadyAt: new Date(Date.now() - 999_999),
          })
          .where(eq(matches.id, matchObj.id));
        const result = await enforceClockExpiry(matchObj.id);
        expect(result).not.toBeNull();
        expect(result!.status).toBe("completed");
        expect(result!.resultReason).toBe("time_forfeit");
        // currentTurnPlayerId='0' (p1) timed out → p2 wins.
        expect(result!.winnerAgentId).toBe(p2.id);
      });
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
      const [p2After] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, p2.id));
      expect(p2After.wins).toBe(1);
    });
  });

  // ── match_payouts idempotency regression ───────────────────────────
  //
  // Before the match_payouts table, payout-tracking lived on the
  // matches row (`payoutAt`, `payoutTxHash`). A cron crash between
  // recipient transfers in a draw refund would re-pay the first side
  // on retry. These tests pin the table contract:
  //   - paid winner → exactly one 'winner' row at split.winnerCut
  //   - paid draw   → two 'draw_refund' rows at stake each
  //   - paid abandon → two 'abandon_refund' rows at stake each
  //   - idempotent re-finalize → no duplicate rows (unique constraint)

  async function seedPaidMatch(db: TestDb) {
    const { agent: p1 } = await seedOwnerAgent(db, {
      handle: "payouts1",
      wallet: "0xaaaa000000000000000000000000000000000001",
    });
    const { agent: p2 } = await seedOwnerAgent(db, {
      handle: "payouts2",
      wallet: "0xbbbb000000000000000000000000000000000002",
    });
    const created = await postChallenge({
      gameType: "tic-tac-toe",
      initiatorAgentId: p1.id,
      mode: "paid",
      stakeUsdc: 10_000_000, // 10 USDC (microUSDC)
    });
    if (created.kind !== "challenge") throw new Error("expected challenge");
    const match = await acceptChallenge({
      challengeId: created.challenge.id,
      acceptorAgentId: p2.id,
    });
    return { p1, p2, match };
  }

  it("paid match natural win → exactly one 'winner' payout row at winnerCut", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { p1, p2, match } = await seedPaidMatch(db);
      await finalizeMatch({
        matchId: match.id,
        winnerAgentId: p1.id,
        resultReason: "natural",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });

      const payouts = await db
        .select()
        .from(matchPayouts)
        .where(eq(matchPayouts.matchId, match.id));
      const winnerRows = payouts.filter((p) => p.payoutReason === "winner");
      expect(winnerRows).toHaveLength(1);
      expect(winnerRows[0].recipientAgentId).toBe(p1.id);
      // pot = 2 * stake = 20 USDC; winner cut = 95% = 19 USDC
      expect(winnerRows[0].amountUsdc).toBe(19_000_000);
      expect(winnerRows[0].status).toBe("pending");
      expect(winnerRows[0].txHash).toBeNull();
      // recipientAddress was captured at finalize time from owner wallet.
      // seedOwnerAgent always sets ownerId, hence the non-null assertion.
      const [ownerP1] = await db
        .select()
        .from(owners)
        .where(eq(owners.id, p1.ownerId!));
      expect(winnerRows[0].recipientAddress.toLowerCase()).toBe(
        ownerP1.walletAddress.toLowerCase(),
      );
      // No draw_refund or abandon_refund rows.
      expect(
        payouts.filter((p) => p.payoutReason === "draw_refund"),
      ).toHaveLength(0);
      expect(
        payouts.filter((p) => p.payoutReason === "abandon_refund"),
      ).toHaveLength(0);
      // p2 (loser) gets nothing.
      expect(payouts.filter((p) => p.recipientAgentId === p2.id)).toHaveLength(
        0,
      );
    });
  });

  it("paid draw → two 'draw_refund' rows at stake each", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { p1, p2, match } = await seedPaidMatch(db);
      await finalizeMatch({
        matchId: match.id,
        winnerAgentId: null,
        resultReason: "draw",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });

      const payouts = await db
        .select()
        .from(matchPayouts)
        .where(eq(matchPayouts.matchId, match.id))
        .orderBy(matchPayouts.recipientAgentId);
      const drawRows = payouts.filter((p) => p.payoutReason === "draw_refund");
      expect(drawRows).toHaveLength(2);
      const recipients = new Set(drawRows.map((r) => r.recipientAgentId));
      expect(recipients.has(p1.id)).toBe(true);
      expect(recipients.has(p2.id)).toBe(true);
      // Each side gets exactly the stake back (Option A — no fee on draws).
      drawRows.forEach((r) => expect(r.amountUsdc).toBe(10_000_000));
      // No winner / abandon rows.
      expect(payouts.filter((p) => p.payoutReason === "winner")).toHaveLength(
        0,
      );
      expect(
        payouts.filter((p) => p.payoutReason === "abandon_refund"),
      ).toHaveLength(0);
    });
  });

  it("paid abandoned → two 'abandon_refund' rows + no treasury fee", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { p1, p2, match } = await seedPaidMatch(db);
      await finalizeMatch({
        matchId: match.id,
        winnerAgentId: null,
        resultReason: "abandoned",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });

      const payouts = await db
        .select()
        .from(matchPayouts)
        .where(eq(matchPayouts.matchId, match.id));
      const abandonRows = payouts.filter(
        (p) => p.payoutReason === "abandon_refund",
      );
      expect(abandonRows).toHaveLength(2);
      abandonRows.forEach((r) => expect(r.amountUsdc).toBe(10_000_000));
      const recipientAgentIds = new Set(
        abandonRows.map((r) => r.recipientAgentId),
      );
      expect(recipientAgentIds.has(p1.id)).toBe(true);
      expect(recipientAgentIds.has(p2.id)).toBe(true);

      // No treasury fee on abandoned matches — the game never started.
      const treasury = await db
        .select()
        .from(treasuryFlows)
        .where(eq(treasuryFlows.matchId, match.id));
      expect(treasury).toHaveLength(0);
    });
  });

  it("re-finalize is idempotent — duplicate payout rows are blocked by the unique constraint", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { p1, match } = await seedPaidMatch(db);

      // First finalize → 1 winner payout row.
      await finalizeMatch({
        matchId: match.id,
        winnerAgentId: p1.id,
        resultReason: "natural",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });

      // Second finalize is a no-op on the match row (already completed)
      // and MUST NOT insert a duplicate payout row even if the early-exit
      // ever regresses. The first call's payout is what runs.
      await finalizeMatch({
        matchId: match.id,
        winnerAgentId: p1.id,
        resultReason: "natural",
        finalP1Ms: 30_000,
        finalP2Ms: 30_000,
      });

      const payouts = await db
        .select()
        .from(matchPayouts)
        .where(eq(matchPayouts.matchId, match.id));
      const winnerRows = payouts.filter((p) => p.payoutReason === "winner");
      // Strictly 1 — not 2.
      expect(winnerRows).toHaveLength(1);
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
        const { agent } = await seedOwnerAgent(db, {
          handle: `wc_${gameType}`,
        });

        // System-mode propose creates an active match with p1=agent on
        // move first; clockBudgetMs floors at the per-game recommendation
        // (60s tic-tac-toe, 120s connect4, 300s chess as of 2026-05).
        const r = await postChallenge({
          gameType,
          initiatorAgentId: agent.id,
          mode: "system",
          systemBotDifficulty: "easy",
        });
        if (r.kind !== "match") throw new Error("expected match");
        const matchId = r.match.id;
        const budget = r.match.clockBudgetMs;

        // Set turnStartedAt 10 seconds ago so myMsLeftLive should
        // show ~(budget - 10_000) ms left.
        // Also stamp agentReadyAt so the readiness gate doesn't fire
        // on the matchState call below — that gate resets
        // turnStartedAt = now() on the FIRST state read by the on-turn
        // agent of a moveCount=0 match, which would invalidate the
        // backdated timestamp we just set up. With agentReadyAt
        // already set, the gate is a no-op and the live remaining
        // computation walks the backdated turnStartedAt as intended.
        //
        // We also bump moveCount=1 so the response uses the FULL
        // clockBudgetMs as the live budget. On moveCount=0 the new
        // first-move-timeout shortcut (architect P0-#136) caps the
        // effective budget at 90s regardless of game — that path has
        // its own coverage below. Here we're testing the long-play
        // chess-clock semantics, which need a non-zero moveCount.
        const tenSecAgo = new Date(Date.now() - 10_000);
        await db
          .update(matches)
          .set({
            turnStartedAt: tenSecAgo,
            agentReadyAt: tenSecAgo,
            moveCount: 1,
          })
          .where(eq(matches.id, matchId));

        const state = (await matchState.handler({ matchId }, {
          agent: { id: agent.id, ownerId: agent.ownerId },
        } as never)) as Record<string, unknown>;

        // Static budget field stays equal to clockBudgetMs.
        expect(state.clockBudgetMs).toBe(budget);
        expect(state.myMsLeft).toBe(budget);
        // Effective budget equals clockBudgetMs once moveCount >= 1.
        expect(state.effectiveBudgetMs).toBe(budget);
        expect(state.firstMoveTimeoutActive).toBe(false);

        // Live remaining decrements with wall clock — ~(budget-10s)
        // with some tolerance for test-runner jitter.
        expect(state.myMsLeftLive).toBeGreaterThan(budget - 15_000);
        expect(state.myMsLeftLive).toBeLessThan(budget - 5_000);

        // Urgency is categorical: > 66% remaining = 'fresh' (the
        // 10s elapsed leaves >= 83% on a 60s budget, even more on
        // bigger budgets, so 'fresh' for every game).
        expect(state.urgency).toBe("fresh");

        // turnDeadline is an ISO timestamp at (turnStartedAt + budget).
        expect(typeof state.turnDeadline).toBe("string");
        const deadlineMs = new Date(state.turnDeadline as string).getTime();
        const expectedDeadline = tenSecAgo.getTime() + budget;
        expect(Math.abs(deadlineMs - expectedDeadline)).toBeLessThan(1000);

        // It is the agent's turn (p1 in system mode).
        expect(state.isMyTurn).toBe(true);
      });
    });
  }

  // Architect P0-#136 — first-move-timeout fields on the MCP response.
  // Verifies the response shape that an LLM agent will consume to
  // detect "I'm under the 90s clock now". Distinct from the cron-level
  // test above which validates server enforcement; this validates the
  // CLIENT-VISIBLE contract so docs and code can't drift.
  it("first-move timeout: response exposes effectiveBudgetMs + firstMoveTimeoutActive + tighter myMsLeftLive on move 0 + ready", async () => {
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    const { FIRST_MOVE_TIMEOUT_MS } = await import("../lifecycle");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "fmt_resp" });
      // Use a long-clock game so the budget delta is visible: chess
      // would give 600s under the normal clock but 90s under the
      // first-move budget — easy to assert the difference.
      const r = await postChallenge({
        gameType: "chess",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "easy",
      });
      if (r.kind !== "match") throw new Error("expected match");
      const matchId = r.match.id;
      const chessBudget = r.match.clockBudgetMs;

      // Move 0, agent went ready 30s ago. The first-move budget is
      // 90s; we expect myMsLeftLive ~ 60_000.
      const thirtySecAgo = new Date(Date.now() - 30_000);
      await db
        .update(matches)
        .set({
          turnStartedAt: thirtySecAgo,
          agentReadyAt: thirtySecAgo,
          // moveCount stays at 0 (the default) — that's the path
          // under test.
        })
        .where(eq(matches.id, matchId));

      const state = (await matchState.handler({ matchId }, {
        agent: { id: agent.id, ownerId: agent.ownerId },
      } as never)) as Record<string, unknown>;

      // The new fields are present and correct:
      expect(state.firstMoveTimeoutActive).toBe(true);
      expect(state.firstMoveTimeoutMs).toBe(FIRST_MOVE_TIMEOUT_MS);
      expect(state.effectiveBudgetMs).toBe(FIRST_MOVE_TIMEOUT_MS);
      // clockBudgetMs stays at the FULL per-game budget — surfaced
      // for context, not as the active deadline.
      expect(state.clockBudgetMs).toBe(chessBudget);

      // myMsLeftLive uses the SHORT budget. 90s - 30s elapsed = ~60s
      // with some tolerance for test runner jitter.
      const live = state.myMsLeftLive as number;
      expect(live).toBeGreaterThan(55_000);
      expect(live).toBeLessThan(65_000);

      // turnDeadline matches the first-move budget, NOT the full
      // clockBudgetMs. If we got 30 minutes here, the LLM would
      // happily wait past 90s and lose the match.
      expect(typeof state.turnDeadline).toBe("string");
      const deadlineMs = new Date(state.turnDeadline as string).getTime();
      const expectedDeadline = thirtySecAgo.getTime() + FIRST_MOVE_TIMEOUT_MS;
      expect(Math.abs(deadlineMs - expectedDeadline)).toBeLessThan(1000);

      // clockRule is the human-readable summary the LLM can quote
      // back to its operator. Includes the 90s figure on this path.
      expect(state.clockRule).toContain("90s");
      expect(state.clockRule).toContain("first-move");
    });
  });

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
      // Tic-tac-toe's per-game floor stays at 60s after the 2026-05
      // recalibration. Scale the elapsed-times against that.
      const budget = r.match.clockBudgetMs;

      // Mark agent as ready up front so subsequent state reads don't
      // reset turnStartedAt (the moveCount=0 readiness gate fires once
      // on first state read by the on-turn agent).
      //
      // ALSO bump moveCount=1 so the urgency derivation walks the
      // FULL clockBudgetMs instead of the 90s first-move timeout.
      // This test parameterizes urgency over % of budget elapsed,
      // which only matches its assertions when the full budget is
      // in play (the first-move-timeout shortcut would cap effective
      // budget at 90s regardless of game and break the 50% / 80% /
      // 95% elapsed assertions for tic-tac-toe (60s) since 50% of
      // 60s ≠ 50% of 90s).
      await db
        .update(matches)
        .set({ agentReadyAt: new Date(), moveCount: 1 })
        .where(eq(matches.id, matchId));

      // fresh: just started — 100% remaining (turnStartedAt = now)
      await db
        .update(matches)
        .set({ turnStartedAt: new Date() })
        .where(eq(matches.id, matchId));
      let state = (await matchState.handler({ matchId }, {
        agent: { id: agent.id, ownerId: agent.ownerId },
      } as never)) as Record<string, unknown>;
      expect(state.urgency).toBe("fresh");

      // half: 50% remaining
      await db
        .update(matches)
        .set({ turnStartedAt: new Date(Date.now() - budget * 0.5) })
        .where(eq(matches.id, matchId));
      state = (await matchState.handler({ matchId }, {
        agent: { id: agent.id, ownerId: agent.ownerId },
      } as never)) as Record<string, unknown>;
      expect(state.urgency).toBe("half");

      // low: 20% remaining = 80% elapsed
      await db
        .update(matches)
        .set({ turnStartedAt: new Date(Date.now() - budget * 0.8) })
        .where(eq(matches.id, matchId));
      state = (await matchState.handler({ matchId }, {
        agent: { id: agent.id, ownerId: agent.ownerId },
      } as never)) as Record<string, unknown>;
      expect(state.urgency).toBe("low");

      // critical: 5% remaining = 95% elapsed
      await db
        .update(matches)
        .set({ turnStartedAt: new Date(Date.now() - budget * 0.95) })
        .where(eq(matches.id, matchId));
      state = (await matchState.handler({ matchId }, {
        agent: { id: agent.id, ownerId: agent.ownerId },
      } as never)) as Record<string, unknown>;
      expect(state.urgency).toBe("critical");
      expect(state.myMsLeftLive).toBeLessThan(budget * 0.1);
    });
  });

  it("myMsLeftLive does NOT decrement when it's the opponent's turn", async () => {
    const { matchState } = await import("@/app/api/mcp/tools/match-state");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "wc_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, {
        handle: "wc_p2",
        elo: 1200,
      });

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

      const p2State = (await matchState.handler({ matchId: match.id }, {
        agent: { id: p2.id, ownerId: p2.ownerId },
      } as never)) as Record<string, unknown>;

      expect(p2State.isMyTurn).toBe(false);
      // p2's own clock isn't ticking, so myMsLeftLive is the full budget.
      expect(p2State.myMsLeftLive).toBe(p2State.clockBudgetMs);
      // But the OPPONENT (p1) IS under pressure — their live remaining
      // should be ~30s less than budget.
      expect(p2State.opponentMsLeftLive).toBeLessThan(
        p2State.clockBudgetMs as number,
      );
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
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
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
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
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
      expect(
        move0.candidates as Array<{ payload: unknown; why: string }>,
      ).toHaveLength(2);
      expect((move0.candidates as Array<{ why: string }>)[0].why).toContain(
        "Center",
      );
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
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
          matchId: r.match.id,
          payload: { index: 0 },
          reasoning:
            "Corner play — sets up two-line fork potential later in the match.",
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
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
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
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
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
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
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

      const state = (await matchState.handler({ matchId: r.match.id }, {
        agent: { id: agent.id, ownerId: agent.ownerId },
      } as never)) as Record<string, unknown>;

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

      await db
        .update(agents)
        .set({ voicePackId: "stoic-samurai" })
        .where(eq(agents.id, p2.id));

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

      const state = (await matchState.handler({ matchId: m.id }, {
        agent: { id: p1.id, ownerId: p1.ownerId },
      } as never)) as Record<string, unknown>;

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
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
          matchId,
          payload: { index: 4 },
          reasoning:
            "Center first move — strongest opening cell in tic-tac-toe.",
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
      const state = (await matchState.handler({ matchId }, {
        agent: { id: agent.id, ownerId: agent.ownerId },
      } as never)) as Record<string, unknown>;

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
      const myMove = recent.find(
        (m) => m.byMe && m.reasoning?.startsWith("Center"),
      );
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
            say: "Test say line meets voice and length requirements",
            reactingTo: { ref: "opponent_move", echo: "their move" },
            matchId: m.id,
            payload: m0.payload,
            reasoning: `${m0.mood} move — playing index ${m0.payload.index} as part of the planned line.`,
            mood: m0.mood,
          },
          { agent: { id: m0.whose.id, ownerId: m0.whose.ownerId } } as never,
        )) as Record<string, unknown>;
        expect(res.error).toBeUndefined();
      }

      // Read from p1's POV.
      const state = (await matchState.handler({ matchId: m.id }, {
        agent: { id: p1.id, ownerId: p1.ownerId },
      } as never)) as Record<string, unknown>;

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
        reasoning:
          "Center to flush out the bot's first response and read its style.",
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
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
          matchId: r.match.id,
          payload: { index: 4 },
          reasoning:
            "Trying broadcast — testing realtime delivery to subscribed channels.",
          mood: "cocky",
          phase: "opening",
        },
        { agent: { id: agent.id, ownerId: agent.ownerId } } as never,
      );

      // Find the move.played broadcast for the human move (not the bot).
      // broadcastGame is called as (channelId, eventName, payload).
      const humanCall = broadcast.mock.calls.find((c) => {
        const payload = c[2] as { reasoning?: string };
        return (
          payload?.reasoning ===
          "Trying broadcast — testing realtime delivery to subscribed channels."
        );
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
        {
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
          matchId: m.id,
          payload: { index: 4 },
          reasoning: R,
        },
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

      const [moveRow] = await db
        .select()
        .from(matchMoves)
        .where(eq(matchMoves.matchId, m.id));
      const reactions = moveRow.reactions as Array<{
        emoji: string;
        fromAgentId?: string | null;
      }>;
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
        {
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
          matchId: m.id,
          payload: { index: 4 },
          reasoning: R,
        },
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
        {
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
          matchId: m.id,
          payload: { index: 4 },
          reasoning: R,
        },
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
      const { agent: outsider } = await seedOwnerAgent(db, {
        handle: "auth_o",
      });
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
        {
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
          matchId: m.id,
          payload: { index: 4 },
          reasoning: R,
        },
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
    const { matchChatSend } =
      await import("@/app/api/mcp/tools/match-chat-send");
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
      const state = (await matchState.handler({ matchId: m.id }, {
        agent: { id: p1.id, ownerId: p1.ownerId },
      } as never)) as {
        chat: Array<{
          id: string;
          byMe: boolean;
          body: string;
          replyToMessageId: string | null;
        }>;
      };
      expect(state.chat).toHaveLength(4);
      expect(state.chat.map((c) => c.id)).toEqual([m1.id, m2.id, m3.id, m4.id]);
      expect(state.chat[0].byMe).toBe(true);
      expect(state.chat[2].byMe).toBe(false); // p2's msg from p1's POV
      expect(state.chat[3].replyToMessageId).toBe(m3.id);
    });
  });

  it("coliseum_match_chat_send rejects non-players + reply mismatches", async () => {
    const { matchChatSend } =
      await import("@/app/api/mcp/tools/match-chat-send");
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
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
          matchId: m.id,
          payload: { index: 4 },
          reasoning: "Center is principled here — I expect a mirror response.",
          plan: "Trap on move 3.",
          mood: "cocky",
          phase: "opening",
        },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      );

      // From p2's POV, opponentLastMove should be p1's move with the
      // full structured payload.
      const state = (await matchState.handler({ matchId: m.id }, {
        agent: { id: p2.id, ownerId: p2.ownerId },
      } as never)) as {
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

      const state = (await matchState.handler({ matchId: r.match.id }, {
        agent: { id: agent.id, ownerId: agent.ownerId },
      } as never)) as {
        opponentVoice: { voicePackId: string; catchphrase: string } | null;
      };

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
      const reactions = humanMove.reactions as Array<{
        emoji: string;
        fromBot?: boolean;
      }>;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].emoji).toBe("🤔");
      expect(reactions[0].fromBot).toBe(true);
    });
  });

  it("chat is ASYNC — agent can send multiple messages without it being their turn", async () => {
    const { matchChatSend } =
      await import("@/app/api/mcp/tools/match-chat-send");
    const { matchMove } = await import("@/app/api/mcp/tools/match-move");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "async_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "async_p2" });
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

      // p1 plays a move.
      const moveOut = (await matchMove.handler(
        {
          say: "Test say line meets voice and length requirements",
          reactingTo: { ref: "opponent_move", echo: "their move" },
          matchId: m.id,
          payload: { index: 4 },
          reasoning: R,
        },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      )) as { error?: string };
      expect(moveOut.error).toBeUndefined();

      // It is now p2's turn. But p1 should still be able to send chat
      // messages WITHOUT it being their turn. Fire 3 in a row.
      for (const body of ["lol", "watch this next move", "trap incoming 😤"]) {
        const out = (await matchChatSend.handler({ matchId: m.id, body }, {
          agent: { id: p1.id, ownerId: p1.ownerId },
        } as never)) as { error?: string };
        expect(out.error).toBeUndefined();
      }

      // p2 (whose turn it is) can ALSO send chats without playing yet.
      for (const body of ["cope", "I see it"]) {
        const out = (await matchChatSend.handler({ matchId: m.id, body }, {
          agent: { id: p2.id, ownerId: p2.ownerId },
        } as never)) as { error?: string };
        expect(out.error).toBeUndefined();
      }

      // Confirm the 5 messages all persisted in oldest-first order.
      const rows = await db
        .select()
        .from(matchChatMessages)
        .where(eq(matchChatMessages.matchId, m.id))
        .orderBy(matchChatMessages.createdAt);
      expect(rows.map((r) => r.body)).toEqual([
        "lol",
        "watch this next move",
        "trap incoming 😤",
        "cope",
        "I see it",
      ]);
    });
  });

  it("coliseum_match_chat_send enforces the 50-per-agent soft cap", async () => {
    const { matchChatSend } =
      await import("@/app/api/mcp/tools/match-chat-send");
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "cap_p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "cap_p2" });
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

      // Spam 50 chats — should all succeed.
      for (let i = 0; i < 50; i++) {
        const out = (await matchChatSend.handler(
          { matchId: m.id, body: `spam-${i}` },
          { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
        )) as { error?: string };
        expect(out.error).toBeUndefined();
      }
      // 51st should error with cap message.
      const out = (await matchChatSend.handler(
        { matchId: m.id, body: "one too many" },
        { agent: { id: p1.id, ownerId: p1.ownerId } } as never,
      )) as { error?: string };
      expect(out.error).toMatch(/chat_cap_reached/);

      // p2's cap is independent — they can still send.
      const p2Out = (await matchChatSend.handler(
        { matchId: m.id, body: "I have headroom" },
        { agent: { id: p2.id, ownerId: p2.ownerId } } as never,
      )) as { error?: string };
      expect(p2Out.error).toBeUndefined();
    });
  });

  it("bot fires an opening chat message on its first move", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent } = await seedOwnerAgent(db, { handle: "bot_chat_open" });
      const r = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: agent.id,
        mode: "system",
        systemBotDifficulty: "hard",
      });
      if (r.kind !== "match") throw new Error("expected match");

      // Human plays move 0 — bot's first move follows in driveSystemBot.
      await applyMove({
        matchId: r.match.id,
        agentId: agent.id,
        payload: { index: 4 },
        reasoning: "Center. Strongest first move on an empty board.",
        thinkingMs: 100,
      });

      // Expect AT LEAST one bot chat message in match_chat_messages
      // (first-move greeting fires at 100%).
      const chats = await db
        .select()
        .from(matchChatMessages)
        .where(eq(matchChatMessages.matchId, r.match.id));
      const botChats = chats.filter((c) => c.fromBot);
      expect(botChats.length).toBeGreaterThanOrEqual(1);
      expect(botChats[0].body.length).toBeGreaterThan(0);
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
        reasoning:
          "Looking for the fork at depth 2 — both diagonals are still open.",
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

// =============================================================================
// Move/annotate split — coliseum_match_annotate flow tests
// =============================================================================
describe("annotateMove", () => {
  it("patches reasoning + clears voice-fidelity", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const c = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (c.kind !== "challenge") throw new Error("challenge expected");
      const m = await acceptChallenge({
        challengeId: c.challenge.id,
        acceptorAgentId: p2.id,
      });
      await applyMove({
        matchId: m.id,
        agentId: p1.id,
        payload: { index: 4 },
        reasoning:
          "Claim the center cell — strongest first move in tic-tac-toe.",
        thinkingMs: 50,
      });
      const updated = await annotateMove({
        matchId: m.id,
        moveNumber: 0,
        agentId: p1.id,
        reasoning:
          "Claim the center cell — strongest first move in tic-tac-toe.",
        plan: "force a fork by move 4",
        mood: "focused",
      });
      expect(updated.reasoning).toBe(
        "Claim the center cell — strongest first move in tic-tac-toe.",
      );
      expect(updated.plan).toBe("force a fork by move 4");
      expect(updated.mood).toBe("focused");
      expect(updated.voiceFidelityScore).toBeNull();
    });
  });

  it("rejects a non-author trying to annotate", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const c = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (c.kind !== "challenge") throw new Error("challenge expected");
      const m = await acceptChallenge({
        challengeId: c.challenge.id,
        acceptorAgentId: p2.id,
      });
      await applyMove({
        matchId: m.id,
        agentId: p1.id,
        payload: { index: 4 },
        reasoning:
          "Claim the center cell — strongest first move in tic-tac-toe.",
        thinkingMs: 50,
      });
      await expect(
        annotateMove({
          matchId: m.id,
          moveNumber: 0,
          agentId: p2.id,
          reasoning:
            "I am rewriting your move's reasoning here as a hostile actor.",
        }),
      ).rejects.toBeInstanceOf(NotMoveAuthorError);
    });
  });

  it("rejects an unknown moveNumber", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const c = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (c.kind !== "challenge") throw new Error("challenge expected");
      const m = await acceptChallenge({
        challengeId: c.challenge.id,
        acceptorAgentId: p2.id,
      });
      await expect(
        annotateMove({
          matchId: m.id,
          moveNumber: 99,
          agentId: p1.id,
          reasoning:
            "Annotating a move that does not exist — this should reject as move_not_found.",
        }),
      ).rejects.toBeInstanceOf(MoveNotFoundError);
    });
  });

  it("rejects after the 5-minute annotate window", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const c = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (c.kind !== "challenge") throw new Error("challenge expected");
      const m = await acceptChallenge({
        challengeId: c.challenge.id,
        acceptorAgentId: p2.id,
      });
      await applyMove({
        matchId: m.id,
        agentId: p1.id,
        payload: { index: 4 },
        reasoning:
          "Claim the center cell — strongest first move in tic-tac-toe.",
        thinkingMs: 50,
      });
      const ancient = new Date(Date.now() - ANNOTATE_WINDOW_MS - 1000);
      await db
        .update(matchMoves)
        .set({ createdAt: ancient })
        .where(eq(matchMoves.matchId, m.id));
      await expect(
        annotateMove({
          matchId: m.id,
          moveNumber: 0,
          agentId: p1.id,
          reasoning:
            "Too late to annotate this move — the 5-minute window has expired.",
        }),
      ).rejects.toBeInstanceOf(AnnotateWindowExpiredError);
    });
  });

  it("PATCH semantics: undefined fields skip, value replaces", async () => {
    await withTestDb(async ({ db }) => {
      currentDb = db;
      const { agent: p1 } = await seedOwnerAgent(db, { handle: "p1" });
      const { agent: p2 } = await seedOwnerAgent(db, { handle: "p2" });
      const c = await postChallenge({
        gameType: "tic-tac-toe",
        initiatorAgentId: p1.id,
        mode: "free",
      });
      if (c.kind !== "challenge") throw new Error("challenge expected");
      const m = await acceptChallenge({
        challengeId: c.challenge.id,
        acceptorAgentId: p2.id,
      });
      // Bundle reasoning + mood up front so the row has values.
      await applyMove({
        matchId: m.id,
        agentId: p1.id,
        payload: { index: 4 },
        reasoning:
          "Original prose explaining the move at submission time — must meet length.",
        mood: "confident",
        thinkingMs: 50,
      });
      // Annotate ONLY reasoning — mood should be preserved (undefined skipped).
      const updated = await annotateMove({
        matchId: m.id,
        moveNumber: 0,
        agentId: p1.id,
        reasoning:
          "Updated prose with a clearer plan — still in calm-professor voice.",
      });
      expect(updated.reasoning).toBe(
        "Updated prose with a clearer plan — still in calm-professor voice.",
      );
      expect(updated.mood).toBe("confident");
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
