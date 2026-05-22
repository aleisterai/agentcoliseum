/**
 * Regression tests for the scrubber snap-to-final logic.
 *
 * Bug being protected against (real production incident): a Connect-4
 * match between @test-agent and the system bot ended on move 7
 * (natural win), but the spectator UI showed the board frozen at
 * move 4 with the FINAL badge above it. The winning move was in the
 * moves array, just not visible until the spectator clicked the
 * scrubber forward or reloaded the page.
 *
 * Root cause: `effectiveIdx = liveMode ? moves.length - 1 :
 * scrubIndex`. When status flipped from active → completed, liveMode
 * was set to false but scrubIndex was still the value from initial
 * render (set when the page first mounted with N moves already
 * present), even though the game continued under live mode to N+M
 * moves.
 *
 * Fix: a useEffect that watches the active→completed transition and
 * snaps scrubIndex to moves.length - 1.
 *
 * Tests below pin every interesting edge of the rule.
 */
import { describe, expect, it } from "vitest";
import { computeFinalSnap } from "./utils";

describe("computeFinalSnap", () => {
  it("snaps to last move when status transitions active → completed", () => {
    expect(
      computeFinalSnap({
        prevStatus: "active",
        currentStatus: "completed",
        movesLength: 7,
      }),
    ).toBe(6);
  });

  it("snaps to last move when status transitions pending → completed", () => {
    // Edge: a match that completed before any agent ever connected
    // (operator force-recall, instant-resolve). Still snap so the
    // spectator sees the move log at the right anchor.
    expect(
      computeFinalSnap({
        prevStatus: "pending",
        currentStatus: "completed",
        movesLength: 0,
      }),
    ).toBe(0);
  });

  it("returns null when status is still active", () => {
    expect(
      computeFinalSnap({
        prevStatus: "active",
        currentStatus: "active",
        movesLength: 5,
      }),
    ).toBeNull();
  });

  it("returns null when both states are completed (re-render, no transition)", () => {
    // Without this guard, a late poll-fallback that delivered a missed
    // move after game-end would re-snap and yank the user out of
    // whatever historical position they were scrubbed to.
    expect(
      computeFinalSnap({
        prevStatus: "completed",
        currentStatus: "completed",
        movesLength: 8,
      }),
    ).toBeNull();
  });

  it("returns null when no transition (active → pending — non-issue path)", () => {
    expect(
      computeFinalSnap({
        prevStatus: "active",
        currentStatus: "pending",
        movesLength: 3,
      }),
    ).toBeNull();
  });

  it("snaps to 0 when transitioning with empty moves array (abandoned)", () => {
    // moveCount=0 → abandoned policy: no clamp pain, scrubber lands
    // at 0 and the WinnerBanner takes care of "no moves played".
    expect(
      computeFinalSnap({
        prevStatus: "active",
        currentStatus: "completed",
        movesLength: 0,
      }),
    ).toBe(0);
  });

  it("snaps to last index for a long match (no off-by-one)", () => {
    expect(
      computeFinalSnap({
        prevStatus: "active",
        currentStatus: "completed",
        movesLength: 250, // 200+ move chess game
      }),
    ).toBe(249);
  });

  it("handles the production-incident scenario verbatim", () => {
    // The actual repro: connect4, 7 total moves stored, scrubber was
    // sitting at moveCount field's stale value (6). After fix:
    // snap target = moves.length - 1 = 6, which is moveNumber 6
    // (the WINNING move). On screen, displayedStateG resolves to
    // moves[6].stateAfterG → final 4-in-a-row board.
    expect(
      computeFinalSnap({
        prevStatus: "active",
        currentStatus: "completed",
        movesLength: 7,
      }),
    ).toBe(6);
  });
});
