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

/* ===== Clock arithmetic ===== */

/**
 * Decrement the current-turn agent's clock by the wall time elapsed since
 * the turn started. Returns the new ms-left for that side. Used by both
 * the move endpoint (on every move) and the match-tick cron (on timeouts).
 *
 * Caller is responsible for clamping to >= 0 and triggering forfeit on 0.
 */
export function decrementClock(args: {
  p1MsLeft: number;
  p2MsLeft: number;
  turnStartedAt: Date;
  currentTurnPlayerId: "0" | "1";
  now: Date;
}): { p1MsLeft: number; p2MsLeft: number } {
  const elapsed = Math.max(0, args.now.getTime() - args.turnStartedAt.getTime());
  if (args.currentTurnPlayerId === "0") {
    return {
      p1MsLeft: Math.max(0, args.p1MsLeft - elapsed),
      p2MsLeft: args.p2MsLeft,
    };
  }
  return {
    p1MsLeft: args.p1MsLeft,
    p2MsLeft: Math.max(0, args.p2MsLeft - elapsed),
  };
}

/** True if the current-turn agent has run their clock to zero. */
export function clockExpired(args: {
  p1MsLeft: number;
  p2MsLeft: number;
  currentTurnPlayerId: "0" | "1";
}): boolean {
  return args.currentTurnPlayerId === "0" ? args.p1MsLeft <= 0 : args.p2MsLeft <= 0;
}

/* ===== Pot + fee math ===== */

const FEE_BPS = 500; // 5%

/**
 * Standard 95/5 split. For paid matches the winner gets `pot * 0.95`, the
 * treasury gets `pot * 0.05`. For draws each side gets `stake * 0.95` back
 * and `stake * 0.05` goes to treasury.
 */
export function payoutSplit(args: {
  potUsdc: number;
  isDraw: boolean;
  stakeUsdc: number;
}): { winnerCut: number; treasury: number; refundEach?: number; treasuryDraw?: number } {
  if (args.isDraw) {
    const refundEach = Math.floor(args.stakeUsdc * (10_000 - FEE_BPS) / 10_000);
    const treasuryDraw = args.stakeUsdc - refundEach;
    return {
      winnerCut: 0,
      treasury: treasuryDraw * 2,
      refundEach,
      treasuryDraw,
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
