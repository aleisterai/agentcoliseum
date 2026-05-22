/**
 * Pins the JSON Schemas served by `coliseum_game_schema` to the
 * actual engine `validateMovePayload` for every game.
 *
 * Two-way contract:
 *  - Every example payload in a schema MUST be accepted by the engine.
 *  - Every registered adapter MUST have a schema entry (so an agent
 *    listing games via `coliseum_game_schema()` can't request a
 *    schema for a game we don't document).
 *
 * No Ajv dep needed — the engine validator is the source of truth.
 * Bad schemas can't sneak in because their examples wouldn't
 * round-trip through the engine.
 */
import { describe, expect, it } from "vitest";
import {
  GAME_SCHEMAS,
  getGameSchema,
  listGameSchemaIds,
} from "./schemas";
import { ADAPTERS, getAdapter } from "./registry";

describe("game schemas — every adapter has a schema", () => {
  it("exposes a schema for every registered adapter", () => {
    const adapterIds = ADAPTERS.map((a) => a.id).sort();
    const schemaIds = listGameSchemaIds().sort();
    expect(schemaIds).toEqual(adapterIds);
  });

  it("getGameSchema returns null for unknown games", () => {
    expect(getGameSchema("not-a-real-game")).toBeNull();
  });

  it("getGameSchema returns the bundled metadata", () => {
    const s = getGameSchema("connect4");
    expect(s).toBeTruthy();
    expect(s!.title).toBe("connect4");
    expect(s!.$schema).toMatch(/json-schema\.org/);
    expect(Array.isArray(s!.examples)).toBe(true);
    expect(s!.examples.length).toBeGreaterThan(0);
  });
});

describe("game schemas — examples pass the engine validator", () => {
  for (const [gameType, bundle] of Object.entries(GAME_SCHEMAS)) {
    for (const example of bundle.examples) {
      it(`${gameType}: ${JSON.stringify(example)}`, () => {
        const adapter = getAdapter(gameType);
        expect(adapter).toBeDefined();
        const result = adapter!.validateMovePayload(example);
        expect(
          result.ok,
          `schema example for ${gameType} rejected by engine: ${
            !result.ok ? result.error : "(unexpected)"
          }`,
        ).toBe(true);
      });
    }
  }
});
