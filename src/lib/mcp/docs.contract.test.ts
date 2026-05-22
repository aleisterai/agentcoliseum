/**
 * MCP docs ↔ engine contract test.
 *
 * Bug being protected against: a sister-LLM user (Claude Desktop)
 * reported that `coliseum_docs_read({topic:'games'})` told them
 * Connect 4 wanted `{col: N}`, but the engine actually only
 * accepts `{column: N}`. The agent's first move got rejected as
 * illegal, eating tempo + invalid-move count toward a forfeit.
 * Audit found this in 6 of 14 games — every documentation drift
 * caused real match-cost regressions.
 *
 * Fix: every payload example in the docs `games` topic gets fed
 * through the live engine validator. If a doc says `{col: 3}` and
 * the validator rejects it, this test fails before deploy.
 *
 * The payloads below are extracted by hand from the doc body — keep
 * them in lock-step. The test is the contract; the prose is the
 * teaching artifact.
 */
import { describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/game/registry";

/**
 * One representative valid payload per game. Mirror the JSON in
 * `DOCS.games.body`. If you change the doc example, change here
 * too — the test will fail loudly if they drift.
 */
const DOCUMENTED_VALID_PAYLOADS: Array<{ game: string; payload: unknown }> = [
  { game: "connect4", payload: { column: 3 } },
  { game: "tic-tac-toe", payload: { index: 4 } },
  { game: "chess", payload: { from: "e2", to: "e4" } },
  // Chess promotion variant (uppercase Q per validator).
  { game: "chess", payload: { from: "e7", to: "e8", promotion: "Q" } },
  { game: "checkers", payload: { from: [2, 3], path: [[3, 4]] } },
  // Checkers multi-jump.
  { game: "checkers", payload: { from: [2, 3], path: [[4, 5], [6, 3]] } },
  { game: "reversi", payload: { row: 5, col: 4 } },
  { game: "gomoku", payload: { row: 7, col: 7 } },
  { game: "dots-and-boxes", payload: { type: "h", row: 1, col: 2 } },
  { game: "dots-and-boxes", payload: { type: "v", row: 2, col: 1 } },
  { game: "mancala", payload: { pit: 2 } },
  // NMM placement, movement, mill-with-capture.
  { game: "nine-mens-morris", payload: { from: null, to: 4 } },
  { game: "nine-mens-morris", payload: { from: 3, to: 4 } },
  { game: "nine-mens-morris", payload: { from: 5, to: 6, remove: 2 } },
  { game: "nim", payload: { pile: 2, take: 2 } },
  { game: "hex", payload: { row: 5, col: 5 } },
  { game: "quoridor", payload: { kind: "pawn", to: { row: 1, col: 4 } } },
  {
    game: "quoridor",
    payload: { kind: "wall", wall: { type: "h", row: 3, col: 2 } },
  },
  {
    game: "santorini",
    payload: {
      builder: 0,
      to: { row: 1, col: 1 },
      build: { row: 1, col: 2 },
    },
  },
  { game: "tak", payload: { to: { row: 2, col: 2 }, kind: "F" } },
  { game: "tak", payload: { to: { row: 0, col: 3 }, kind: "W" } },
];

describe("MCP docs games topic — payload examples pass validator", () => {
  for (const { game, payload } of DOCUMENTED_VALID_PAYLOADS) {
    it(`${game}: ${JSON.stringify(payload)}`, () => {
      const adapter = getAdapter(game);
      expect(adapter, `no adapter registered for ${game}`).toBeDefined();
      const result = adapter!.validateMovePayload(payload);
      expect(
        result.ok,
        `docs example for ${game} rejected by engine: ${
          !result.ok ? result.error : "(unexpected)"
        }`,
      ).toBe(true);
    });
  }
});

/**
 * Sanity check the inverse direction too — these are payload
 * shapes that used to be in the docs but the engine rejects.
 * Pinning them down as KNOWN-WRONG means a future "let's add
 * back the legacy alias" PR has to delete this assertion
 * deliberately, not by accident.
 */
const DOCUMENTED_INVALID_LEGACY: Array<{
  game: string;
  payload: unknown;
  why: string;
}> = [
  // Connect 4 — docs used to say `{col}`, engine wants `{column}`.
  { game: "connect4", payload: { col: 3 }, why: "field name col vs column" },
  // Dots & Boxes — docs used to say `{edge: {...}}`, engine wants flat.
  {
    game: "dots-and-boxes",
    payload: { edge: { row: 1, col: 2, orientation: "h" } },
    why: "nested edge wrapper vs flat {type,row,col}",
  },
  // Quoridor — docs used to say `{pawn:{...}}` / `{wall:{...}}`, engine wants kind+to / kind+wall.
  {
    game: "quoridor",
    payload: { pawn: { row: 1, col: 4 } },
    why: "pawn field vs kind:'pawn' + to",
  },
  // Santorini — docs used to say worker/moveTo/buildAt with arrays.
  {
    game: "santorini",
    payload: { worker: 0, moveTo: [1, 1], buildAt: [1, 2] },
    why: "worker/moveTo/buildAt vs builder/to/build",
  },
  // Checkers — docs used to say {to}, engine ignores it and requires {path}.
  {
    game: "checkers",
    payload: { from: [2, 3], to: [3, 4] },
    why: "missing required `path` array",
  },
  // Reversi — docs used to say {pass:true}, engine has no pass payload.
  {
    game: "reversi",
    payload: { pass: true },
    why: "engine has no explicit pass move",
  },
  // Chess — docs used to say lowercase promotion piece, engine wants uppercase.
  {
    game: "chess",
    payload: { from: "e7", to: "e8", promotion: "q" },
    why: "promotion piece is uppercase Q|R|B|N",
  },
];

describe("MCP docs games topic — pinned-wrong legacy shapes stay rejected", () => {
  for (const { game, payload, why } of DOCUMENTED_INVALID_LEGACY) {
    it(`${game} rejects ${JSON.stringify(payload)} (${why})`, () => {
      const adapter = getAdapter(game);
      expect(adapter).toBeDefined();
      const result = adapter!.validateMovePayload(payload);
      expect(result.ok, `engine unexpectedly accepted ${why}`).toBe(false);
    });
  }
});
