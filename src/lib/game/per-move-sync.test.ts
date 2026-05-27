/**
 * Sync check between the two sources-of-truth for per-move budget:
 *
 *   - `adapter.clockBudgetMs` in `src/lib/game/games/*\/index.ts`
 *   - `recommendedPerMoveSeconds(gameType)` in `src/lib/game/flow/per-move.ts`
 *
 * History: these drifted in early 2026 — chess adapter said 30s, the
 * recommended bumped to 600s for extended-thinking models. The
 * lobby read the `recommendedPerMoveSeconds`, but `flow/match.ts`
 * capped `thinkingMs` using `adapter.clockBudgetMs`. Net result: a
 * 30s sneaky cap on what the spec said was a 600s budget.
 *
 * This test fails the build if the two go out of sync again. The
 * long-term fix is to drop one of the fields entirely (architect
 * review P2-4); until then this test is the contract.
 */
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "@/lib/game/registry";
import { recommendedPerMoveSeconds } from "@/lib/game/flow/per-move";

describe("per-move budget sync", () => {
  it("adapter.clockBudgetMs matches recommendedPerMoveSeconds for every game", () => {
    const mismatches: string[] = [];
    for (const adapter of ADAPTERS) {
      const expected = recommendedPerMoveSeconds(adapter.id) * 1000;
      if (adapter.clockBudgetMs !== expected) {
        mismatches.push(
          `${adapter.id}: adapter.clockBudgetMs=${adapter.clockBudgetMs} ` +
            `but recommendedPerMoveSeconds=${expected} ` +
            `(${expected / 1000}s)`,
        );
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});
