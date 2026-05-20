/**
 * Contract tests for the realtime payload types.
 *
 * Most checks here are compile-time `satisfies` assertions — they exist
 * to make a future field rename break the build instead of silently
 * freezing the spectator's board (the bug class we already shipped a
 * fix for). The runtime expectations are minimal: that JSON
 * round-tripping preserves the structure since broadcasts are emitted
 * over the wire as plain JSON.
 */
import { describe, expect, it } from "vitest";
import type {
  MovePlayedPayload,
  GameEndedPayload,
  ChatMessagePayload,
  ReactionPayload,
  LobbyGameCreatedPayload,
  LobbyGameEndedPayload,
} from "./realtime-types";

describe("realtime payload contracts", () => {
  it("MovePlayedPayload survives JSON round-trip", () => {
    const original: MovePlayedPayload = {
      matchId: "m_123",
      moveNumber: 0,
      payload: { index: 4 },
      reasoning: "center is strong",
      evScore: 0.3,
      thinkingMs: 1234,
      x402PaymentId: null,
      stateAfterG: { board: [0, 0, 0, 0, 1, 0, 0, 0, 0] },
      currentTurnAgentId: "a_456",
      currentTurnPlayerId: "1",
      turnStartedAt: "2026-05-19T21:00:00.000Z",
      p1MsLeft: 30000,
      p2MsLeft: 30000,
    };
    const roundTripped = JSON.parse(JSON.stringify(original)) as MovePlayedPayload;
    expect(roundTripped).toEqual(original);
  });

  it("MovePlayedPayload allows the isBot flag (system-bot broadcasts set it)", () => {
    const p = {
      matchId: "m_1",
      moveNumber: 1,
      payload: { auto: true },
      reasoning: null,
      evScore: null,
      thinkingMs: 50,
      x402PaymentId: null,
      stateAfterG: {},
      currentTurnAgentId: "a_1",
      currentTurnPlayerId: "0",
      turnStartedAt: "2026-05-19T21:00:00.000Z",
      p1MsLeft: 30000,
      p2MsLeft: 30000,
      isBot: true,
    } satisfies MovePlayedPayload;
    expect(p.isBot).toBe(true);
  });

  it("GameEndedPayload allows winnerAgentId=null on draws + 0-delta ELO", () => {
    const p: GameEndedPayload = {
      matchId: "m_1",
      winnerAgentId: null,
      resultReason: "draw",
      p1EloDelta: 0,
      p2EloDelta: 0,
    };
    expect(p.winnerAgentId).toBeNull();
    expect(p.resultReason).toBe("draw");
  });

  it("ChatMessagePayload requires id + body, allows null speaker fields", () => {
    const p: ChatMessagePayload = {
      id: "c_1",
      speakerOwnerId: null,
      anonymousToken: "tok_xyz",
      body: "hello",
      createdAt: "2026-05-19T21:00:00.000Z",
    };
    expect(p.id).toBe("c_1");
    expect(p.body).toBe("hello");
  });

  it("ReactionPayload is just the emoji glyph", () => {
    const p: ReactionPayload = { emoji: "🔥" };
    expect(p.emoji).toBe("🔥");
  });

  it("LobbyGameCreatedPayload narrows mode to the union", () => {
    const free: LobbyGameCreatedPayload = { id: "c_1", gameType: "chess", mode: "free" };
    const paid: LobbyGameCreatedPayload = { id: "c_2", gameType: "chess", mode: "paid" };
    const system: LobbyGameCreatedPayload = { id: "c_3", gameType: "chess", mode: "system" };
    expect([free.mode, paid.mode, system.mode]).toEqual(["free", "paid", "system"]);
  });

  it("LobbyGameEndedPayload is just the match id", () => {
    const p: LobbyGameEndedPayload = { id: "m_done" };
    expect(p.id).toBe("m_done");
  });
});
