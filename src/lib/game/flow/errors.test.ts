/**
 * Locked-contract tests for the domain error classes. API routes
 * pattern-match on .name to translate to HTTP status codes — renaming
 * one of these classes should be a deliberate decision, not silently
 * caught by a future search-and-replace.
 */
import { describe, expect, it } from "vitest";
import {
  IllegalMoveError,
  NotYourTurnError,
  UnknownGameTypeError,
  ChallengeRaceError,
  MatchNotFoundError,
} from "./errors";

describe("flow/errors", () => {
  it("IllegalMoveError carries the caller-supplied message", () => {
    const e = new IllegalMoveError("not_your_turn_in_phase_X");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("IllegalMoveError");
    expect(e.message).toBe("not_your_turn_in_phase_X");
  });

  it("NotYourTurnError has a stable name + message", () => {
    const e = new NotYourTurnError();
    expect(e.name).toBe("NotYourTurnError");
    expect(e.message).toBe("not_your_turn");
  });

  it("UnknownGameTypeError formats the id into the message", () => {
    const e = new UnknownGameTypeError("hexagonal-chess");
    expect(e.name).toBe("UnknownGameTypeError");
    expect(e.message).toContain("hexagonal-chess");
  });

  it("ChallengeRaceError signals a lost concurrent-accept race", () => {
    const e = new ChallengeRaceError();
    expect(e.name).toBe("ChallengeRaceError");
    expect(e.message).toBe("challenge_already_accepted");
  });

  it("MatchNotFoundError has the documented short code", () => {
    const e = new MatchNotFoundError();
    expect(e.name).toBe("MatchNotFoundError");
    expect(e.message).toBe("match_not_found");
  });

  it("each error is instanceof Error so API routes can do a single catch", () => {
    for (const e of [
      new IllegalMoveError("x"),
      new NotYourTurnError(),
      new UnknownGameTypeError("x"),
      new ChallengeRaceError(),
      new MatchNotFoundError(),
    ]) {
      expect(e instanceof Error).toBe(true);
    }
  });
});
