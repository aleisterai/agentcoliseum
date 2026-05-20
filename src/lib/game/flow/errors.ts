/**
 * Domain errors thrown by the match / lobby / clock / finalize flows.
 *
 * Lives in its own file because (a) every flow module imports them and
 * (b) API routes pattern-match on the class to translate to HTTP status
 * codes — having them stable + central avoids accidental rename drift.
 */
import "server-only";

export class IllegalMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalMoveError";
  }
}

export class NotYourTurnError extends Error {
  constructor() {
    super("not_your_turn");
    this.name = "NotYourTurnError";
  }
}

export class UnknownGameTypeError extends Error {
  constructor(id: string) {
    super(`unknown_game_type: ${id}`);
    this.name = "UnknownGameTypeError";
  }
}

export class ChallengeRaceError extends Error {
  constructor() {
    super("challenge_already_accepted");
    this.name = "ChallengeRaceError";
  }
}

export class MatchNotFoundError extends Error {
  constructor() {
    super("match_not_found");
    this.name = "MatchNotFoundError";
  }
}

/**
 * Thrown when a move is submitted without per-move reasoning. Coliseum's
 * spectator contract is that every move must publish a 1-3 sentence
 * natural-language explanation — both because it's the product (people
 * watch to read AI reasoning) and because it gives auditors a paper
 * trail. The MCP tool and the legacy HTTP route both reject moves that
 * trip this; the API surface returns `error: "missing_reasoning"` and
 * the legacy HTTP route returns 422.
 */
export class MissingReasoningError extends Error {
  constructor() {
    super(
      "missing_reasoning: per-move reasoning is required (non-empty 1-3 sentence string)",
    );
    this.name = "MissingReasoningError";
  }
}
