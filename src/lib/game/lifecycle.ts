/**
 * Game lifecycle state machine.
 *
 * Defines every legal state a match can be in and the transitions between
 * them. Discriminated unions so consumers get exhaustiveness checks.
 *
 * This module is PURE — no DB, no network. The DB layer in server-flow.ts
 * and the API routes map their persistent state (challenges/matches tables)
 * onto these types and call the transition helpers here to enforce legality.
 *
 *   challenge:  draft → posted → matching → escrowed → (becomes match)
 *                                                    ↘ abandoned
 *   match:      active → resolving → completed
 *                                  ↘ abandoned
 *                                  ↘ disputed
 */

/* ===== Challenge states ===== */

export interface ChallengeBase {
  id: string;
  gameType: string;
  initiatorAgentId: string;
  mode: "free" | "paid" | "system";
  stakeUsdc: number | null;
  potUsdc: number | null;
  platformFeeUsdc: number | null;
  systemBotDifficulty?: "easy" | "medium" | "hard" | null;
  opponentHandle: string | null;
  eloMin: number | null;
  eloMax: number | null;
  timeoutMin: number;
  postedAt: Date;
  expiresAt: Date;
}

export interface ChallengeDraft extends ChallengeBase {
  status: "draft";
}
export interface ChallengePosted extends ChallengeBase {
  status: "posted";
  initiatorEscrowLockedAt: Date | null;
}
export interface ChallengeMatching extends ChallengeBase {
  status: "matching";
  initiatorEscrowLockedAt: Date | null;
  acceptorAgentId: string;
  matchingStartedAt: Date;
}
export interface ChallengeEscrowed extends ChallengeBase {
  status: "escrowed";
  initiatorEscrowLockedAt: Date;
  acceptorAgentId: string;
  acceptorEscrowLockedAt: Date;
  matchedAt: Date;
  matchId: string;
}
export interface ChallengeAbandoned extends ChallengeBase {
  status: "abandoned";
  abandonedAt: Date;
  abandonedReason: "timeout" | "initiator_cancel" | "acceptor_failed" | "elo_mismatch" | "tier_failed";
}

export type Challenge =
  | ChallengeDraft
  | ChallengePosted
  | ChallengeMatching
  | ChallengeEscrowed
  | ChallengeAbandoned;

/* ===== Match states ===== */

export interface MatchBase {
  id: string;
  gameType: string;
  mode: "free" | "paid" | "system";
  p1AgentId: string | null;
  p2AgentId: string | null;
  systemBotDifficulty?: "easy" | "medium" | "hard" | null;
  stakeUsdc: number | null;
  potUsdc: number | null;
  platformFeeUsdc: number | null;
  state: unknown; // boardgame.io State<TG>
  currentTurnPlayerId: "0" | "1";
  currentTurnAgentId: string | null;
  turnStartedAt: Date;
  p1MsLeft: number;
  p2MsLeft: number;
  clockBudgetMs: number;
  p1InvalidCount: number;
  p2InvalidCount: number;
  moveCount: number;
  startedAt: Date;
  lastMoveAt: Date | null;
}

export interface MatchActive extends MatchBase {
  status: "active";
}
export interface MatchResolving extends MatchBase {
  status: "resolving";
  winnerAgentId: string | null;
  resultReason: ResultReason;
  p1EloDelta: number | null;
  p2EloDelta: number | null;
}
export interface MatchCompleted extends MatchBase {
  status: "completed";
  winnerAgentId: string | null;
  resultReason: ResultReason;
  p1EloDelta: number;
  p2EloDelta: number;
  payoutTxHash: string | null;
  payoutAt: Date | null;
  completedAt: Date;
}
export interface MatchAbandoned extends MatchBase {
  status: "abandoned";
  abandonedAt: Date;
  resultReason: "abandoned";
}
export interface MatchDisputed extends MatchBase {
  status: "disputed";
  resultReason: "natural" | "invalid_move_forfeit" | "time_forfeit";
}

export type Match =
  | MatchActive
  | MatchResolving
  | MatchCompleted
  | MatchAbandoned
  | MatchDisputed;

export type ResultReason =
  | "natural"
  | "time_forfeit"
  | "invalid_move_forfeit"
  | "resign"
  | "draw"
  | "abandoned";

/* ===== Transition predicates ===== */

/** A move is only legal during `active`. */
export function canApplyMove(m: { status: Match["status"] }): m is { status: "active" } {
  return m.status === "active";
}

/** Finalization can fire from `active` (just ended) or `resolving` (retry). */
export function canFinalize(m: { status: Match["status"] }): m is {
  status: "active" | "resolving";
} {
  return m.status === "active" || m.status === "resolving";
}

/* ===== Clock arithmetic =====
 *
 * Per-move clock (NOT total-budget). Each player gets `perMoveMs` to make
 * each move; the timer resets on every move. If the current-turn player
 * lets it hit zero, they forfeit and the other player wins — there is
 * ALWAYS a winner on a time forfeit. (Draws are decided by the engine,
 * not the clock.)
 *
 * We deliberately don't accumulate per-side time. A spectator product
 * cares about "make a move within ~120s" pacing (recalibrated 2026-05
 * from 30s — LLM reasoning generation dominates wall-clock), not
 * Lichess-style time pressure. Bots and LLMs should respond promptly;
 * if they don't, the match shouldn't hang the lobby.
 */

/**
 * Hard cap for the FIRST move after an agent confirms readiness.
 *
 * Why a separate, shorter budget than `perMoveMs`: an agent who has
 * already called `coliseum_match_state` (so we know its MCP is live
 * and the user approved the tools) but then sits on move 0 for the
 * full per-move budget (up to 600s for chess) is almost never
 * "thinking deeply" — it's stuck, hung, or its operator walked away.
 * Holding the lobby slot open for 10 minutes on those stalls hurt
 * the visible "live games" count during the sim run that surfaced
 * this bug (architect P0-#136: "40 live games at 0 moves").
 *
 * 90 seconds is generous enough to cover a slow first-token-latency
 * LLM call (Claude/GPT median TTFT ~1s; p99 ~30s for a 240-token
 * reasoning block) while still being short enough that the lobby
 * doesn't fill up with abandoned matches. The full `perMoveMs`
 * budget remains in effect for moves 1+ where the agent has already
 * proven it's responsive.
 */
export const FIRST_MOVE_TIMEOUT_MS = 90 * 1000;

/**
 * True if the current-turn player has used their per-move budget.
 *
 * Move-0 gate: a freshly-created match where `moveCount === 0` and
 * `agentReadyAt === null` is "frozen" — the per-move clock has not
 * started yet because we have no proof the on-turn agent's MCP
 * connection is live + the user has approved the read tools. The
 * clock-expiry crons MUST treat these as not expired regardless of
 * how much wall time has elapsed since match creation; a separate
 * long-tail cron (`refund-unready-matches`) sweeps them after 30 min.
 *
 * Move-0-ready short-circuit: when `moveCount === 0` AND
 * `agentReadyAt` IS set, we use the shorter `FIRST_MOVE_TIMEOUT_MS`
 * budget (currently 90s) instead of the full `perMoveMs`. See the
 * doc comment on FIRST_MOVE_TIMEOUT_MS for the rationale. This is
 * the move-0 stall fix for architect P0-#136.
 *
 * From move 1+ both gates are moot — agentReadyAt is set,
 * turnStartedAt is authoritative, and the per-move budget applies
 * normally.
 */
export function clockExpired(args: {
  turnStartedAt: Date;
  perMoveMs: number;
  now: Date;
  moveCount?: number;
  agentReadyAt?: Date | null;
}): boolean {
  if (args.moveCount === 0 && !args.agentReadyAt) return false;
  // Move-0 stall: tighter timeout when the agent has gone ready but
  // never played its opener. Measured from `turnStartedAt` (set by
  // the first match_state call to the same `now` that stamped
  // `agentReadyAt`) so the two timestamps are interchangeable.
  if (args.moveCount === 0 && args.agentReadyAt) {
    const sinceReady = args.now.getTime() - args.turnStartedAt.getTime();
    return sinceReady >= FIRST_MOVE_TIMEOUT_MS;
  }
  const elapsed = args.now.getTime() - args.turnStartedAt.getTime();
  return elapsed >= args.perMoveMs;
}

/**
 * Milliseconds remaining for the current move. >= 0. UI display + cron filter.
 *
 * For unready matches (move 0, agentReadyAt null), returns the full
 * per-move budget — the clock hasn't started ticking, so all of it
 * remains. The cron uses this to skip-filter; the UI uses it to
 * render an honest deadline. The match-state response upgrades this
 * with an `unready: true` field so the LLM knows the budget will reset
 * on its first call.
 */
export function msLeftThisMove(args: {
  turnStartedAt: Date;
  perMoveMs: number;
  now: Date;
  moveCount?: number;
  agentReadyAt?: Date | null;
}): number {
  if (args.moveCount === 0 && !args.agentReadyAt) return args.perMoveMs;
  // Move-0 ready: tighter first-move budget. Keep the live ms-left
  // honest so the spectator UI countdown matches when the cron will
  // actually fire.
  if (args.moveCount === 0 && args.agentReadyAt) {
    return Math.max(
      0,
      FIRST_MOVE_TIMEOUT_MS - (args.now.getTime() - args.turnStartedAt.getTime()),
    );
  }
  return Math.max(0, args.perMoveMs - (args.now.getTime() - args.turnStartedAt.getTime()));
}

/* ===== Pot + fee math ===== */

const FEE_BPS = 500; // 5%

/**
 * Standard 95/5 split for a winner. Treasury fee is taken from the **pot
 * total** — winner cuts pot×0.95, treasury keeps pot×0.05.
 *
 * Draws (per product decision): **full refund, zero fee**. The platform
 * monetizes wins, not plays — a draw is neither agent capturing value
 * from the other, so the house has nothing to skim. Each side gets
 * exactly their stake back; treasury is 0 and finalizeMatch skips the
 * treasury-flow insert entirely. See `lifecycle.test.ts` for the locked
 * contract test.
 */
export function payoutSplit(args: {
  potUsdc: number;
  isDraw: boolean;
  stakeUsdc: number;
}): { winnerCut: number; treasury: number; refundEach?: number; treasuryDraw?: number } {
  if (args.isDraw) {
    return {
      winnerCut: 0,
      treasury: 0,
      refundEach: args.stakeUsdc,
      treasuryDraw: 0,
    };
  }
  const treasury = Math.floor((args.potUsdc * FEE_BPS) / 10_000);
  return {
    winnerCut: args.potUsdc - treasury,
    treasury,
  };
}

/* ===== Elo ===== */

const K = 32;
const ELO_FLOOR = 100;

/** Returns the new ratings + deltas given an outcome from p1's perspective. */
export function eloUpdate(args: {
  p1Elo: number;
  p2Elo: number;
  outcome: "p1_win" | "p2_win" | "draw";
}): { p1Elo: number; p2Elo: number; p1Delta: number; p2Delta: number } {
  const expectedP1 = 1 / (1 + Math.pow(10, (args.p2Elo - args.p1Elo) / 400));
  const scoreP1 = args.outcome === "p1_win" ? 1 : args.outcome === "draw" ? 0.5 : 0;
  const scoreP2 = 1 - scoreP1;
  const expectedP2 = 1 - expectedP1;
  const p1Delta = Math.round(K * (scoreP1 - expectedP1));
  const p2Delta = Math.round(K * (scoreP2 - expectedP2));
  return {
    p1Elo: Math.max(ELO_FLOOR, args.p1Elo + p1Delta),
    p2Elo: Math.max(ELO_FLOOR, args.p2Elo + p2Delta),
    p1Delta,
    p2Delta,
  };
}
