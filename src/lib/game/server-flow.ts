/**
 * Server-side match orchestration — re-export facade.
 *
 * The implementations live in src/lib/game/flow/. This file exists so
 * the many existing callers (`from "@/lib/game/server-flow"`) keep
 * working without a sweeping import-path rename. New code can import
 * from the focused modules directly:
 *
 *   - flow/errors.ts    — IllegalMoveError, NotYourTurnError, etc
 *   - flow/lobby.ts     — postChallenge, acceptChallenge, PerMoveSeconds
 *   - flow/match.ts     — applyMove, driveSystemBot, ApplyMoveInput
 *   - flow/clock.ts     — enforceClockExpiry, findStaleMatches
 *   - flow/finalize.ts  — finalizeMatch, FinalizeArgs
 *
 * Pure-rules helpers live in each adapter's `games/<id>/game.ts`. This
 * layer holds DB-bound orchestration only.
 */
import "server-only";

export {
  IllegalMoveError,
  NotYourTurnError,
  UnknownGameTypeError,
  ChallengeRaceError,
  MatchNotFoundError,
  MissingReasoningError,
  OffVoiceError,
} from "./flow/errors";

export {
  PER_MOVE_PRESETS,
  DEFAULT_PER_MOVE_SECONDS,
  isValidPerMoveSeconds,
  postChallenge,
  acceptChallenge,
  type PerMoveSeconds,
  type PostChallengeInput,
  type AcceptChallengeInput,
} from "./flow/lobby";

export {
  applyMove,
  driveSystemBot,
  type ApplyMoveInput,
} from "./flow/match";

export {
  enforceClockExpiry,
  findStaleMatches,
} from "./flow/clock";

export {
  finalizeMatch,
  type FinalizeArgs,
} from "./flow/finalize";

export {
  addReaction,
  appendReaction,
  applyTapback,
  postMatchChat,
  type ReactionTarget,
  type ReactionSource,
} from "./flow/interactions";
