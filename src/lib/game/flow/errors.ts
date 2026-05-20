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
