/**
 * Unit tests for the unified MCP error envelope (`toToolError` /
 * `toolError`). These cover the translation table from every domain
 * error class to its canonical envelope code + the rich details
 * carried through for the structured errors (OffVoice, MissingReasoning,
 * NotEngagingOpponent).
 *
 * Why a dedicated test file? Before this helper existed, error shapes
 * were duplicated across 18 tool files and silently drifted. The audit
 * found 4 competing patterns. The risk vector is a tool catch block
 * forgetting to call `toToolError` or someone changing one of the
 * domain error classes without updating the translator. This file
 * pins the contract: change one and these tests fail.
 */
import { describe, expect, it } from "vitest";

import {
  ChallengeRaceError,
  IllegalMoveError,
  MatchNotFoundError,
  MissingReasoningError,
  NotEngagingOpponentError,
  NotYourTurnError,
  OffVoiceError,
  UnknownGameTypeError,
} from "@/lib/game/flow/errors";

import { toToolError, toolError } from "./_shared";

describe("toolError (direct construction)", () => {
  it("builds the canonical envelope", () => {
    const env = toolError("validation_failed", "missing matchId");
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("validation_failed");
    expect(env.error.message).toBe("missing matchId");
    expect(env.error.details).toBeUndefined();
    expect(env.error.hint).toBeUndefined();
  });

  it("includes details + hint when provided", () => {
    const env = toolError("validation_failed", "bad input", {
      details: { field: "matchId", got: 42 },
      hint: "use a uuid",
    });
    expect(env.error.details).toEqual({ field: "matchId", got: 42 });
    expect(env.error.hint).toBe("use a uuid");
  });
});

describe("toToolError translation table", () => {
  it("MatchNotFoundError → match_not_found", () => {
    const env = toToolError(new MatchNotFoundError());
    expect(env.error.code).toBe("match_not_found");
    expect(env.error.hint).toContain("coliseum_match_list");
  });

  it("NotYourTurnError → not_your_turn", () => {
    const env = toToolError(new NotYourTurnError());
    expect(env.error.code).toBe("not_your_turn");
    expect(env.error.hint).toContain("coliseum_match_state");
  });

  it("ChallengeRaceError → challenge_already_accepted", () => {
    const env = toToolError(new ChallengeRaceError());
    expect(env.error.code).toBe("challenge_already_accepted");
  });

  it("UnknownGameTypeError → unknown_game_type", () => {
    const env = toToolError(new UnknownGameTypeError("nonesuch"));
    expect(env.error.code).toBe("unknown_game_type");
    expect(env.error.hint).toContain("coliseum_docs_read");
  });

  it("MissingReasoningError → missing_reasoning with minChars detail", () => {
    const env = toToolError(new MissingReasoningError());
    expect(env.error.code).toBe("missing_reasoning");
    expect(env.error.details?.minChars).toBe(40);
    expect(env.error.hint).toMatch(/voice gate|on `say`/i);
  });

  it("OffVoiceError → off_voice with expectedMarkers + got details", () => {
    const err = new OffVoiceError(
      "trash-talker",
      ["bro", "cope", "ez"],
      "Standard mainline opening.",
    );
    const env = toToolError(err);
    expect(env.error.code).toBe("off_voice");
    expect(env.error.details).toMatchObject({
      voicePackId: "trash-talker",
      expectedAtLeastOneOf: ["bro", "cope", "ez"],
      got: "Standard mainline opening.",
    });
  });

  it("NotEngagingOpponentError → not_engaging_opponent with moveCount", () => {
    const env = toToolError(new NotEngagingOpponentError(3));
    expect(env.error.code).toBe("not_engaging_opponent");
    expect(env.error.details?.moveCount).toBe(3);
  });

  it("IllegalMoveError → illegal_move with reason detail", () => {
    const env = toToolError(new IllegalMoveError("column_full"));
    expect(env.error.code).toBe("illegal_move");
    expect(env.error.details?.reason).toBe("column_full");
    expect(env.error.hint).toContain("coliseum_game_schema");
  });

  it("unknown error → internal_error fallback", () => {
    const env = toToolError(new Error("something exploded"));
    expect(env.error.code).toBe("internal_error");
    expect(env.error.message).toBe("something exploded");
  });

  it("non-Error throw → internal_error string-coerced", () => {
    const env = toToolError("just a string");
    expect(env.error.code).toBe("internal_error");
    expect(env.error.message).toBe("just a string");
  });
});

describe("envelope wire shape", () => {
  it("always sets ok:false on errors", () => {
    const envelopes = [
      toolError("validation_failed", "x"),
      toToolError(new MatchNotFoundError()),
      toToolError(new IllegalMoveError("y")),
      toToolError(new Error("z")),
    ];
    envelopes.forEach((env) => expect(env.ok).toBe(false));
  });

  it("never leaks a stack trace into the response", () => {
    const err = new Error("internal: db connection refused");
    err.stack = "Error: secret stack trace ...\nat secret.ts:1";
    const env = toToolError(err);
    // The message is allowed to leak (it's the caught exception's own
    // message) but `details` and `hint` must not contain `stack`.
    expect(JSON.stringify(env.error.details ?? {})).not.toContain(
      "secret stack",
    );
    expect(env.error.hint ?? "").not.toContain("secret stack");
  });
});
