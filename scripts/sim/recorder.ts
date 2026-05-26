/**
 * recorder.ts — shape + helpers for per-match telemetry.
 *
 * Every runner call returns one MatchRecord. The reporter aggregates
 * them into the structured JSON dropped under scripts/sim/report-*.json.
 *
 * Field choices follow the brief:
 *   scenarioId, matchId, gameType, opponent, durationMs, moveCount,
 *   outcome, errors:[{phase, code, message, ts}], timeouts:[{phase, ms}]
 *
 * `outcome` is normalized so the aggregator can bucket without re-
 * parsing strings: 'win' | 'loss' | 'draw' | 'time_forfeit' |
 * 'illegal_move_forfeit' | 'abandoned' | 'sim_timeout' | 'unknown'.
 */

export type Phase =
  | "propose"
  | "state_read"
  | "wait_state"
  | "move_submit"
  | "encode_move"
  | "finalize"
  | "fatal";

export interface ScenarioError {
  phase: Phase;
  code: string;
  message: string;
  /** Wall-clock timestamp the error was observed at. */
  ts: string;
  /** Optional extra context — HTTP status, server-side details. */
  details?: unknown;
}

export interface ScenarioTimeout {
  phase: Phase;
  /** Elapsed ms when we gave up. */
  ms: number;
}

export type Outcome =
  | "win"
  | "loss"
  | "draw"
  | "time_forfeit"
  | "illegal_move_forfeit"
  | "abandoned"
  | "sim_timeout"
  | "unknown";

export interface MatchRecord {
  scenarioId: string;
  matchId: string | null;
  gameType: string;
  opponent: string;
  difficulty: string;
  mode: string;
  agentLabel: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  moveCount: number;
  outcome: Outcome;
  /** Server-reported resultReason if available. */
  resultReason: string | null;
  /** True if the agent won. False if lost/drew. Null if unfinished. */
  iWon: boolean | null;
  errors: ScenarioError[];
  timeouts: ScenarioTimeout[];
}

export function newRecord(args: {
  scenarioId: string;
  gameType: string;
  opponent: string;
  difficulty: string;
  mode: string;
  agentLabel: string;
}): MatchRecord {
  const now = new Date().toISOString();
  return {
    scenarioId: args.scenarioId,
    matchId: null,
    gameType: args.gameType,
    opponent: args.opponent,
    difficulty: args.difficulty,
    mode: args.mode,
    agentLabel: args.agentLabel,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    moveCount: 0,
    outcome: "unknown",
    resultReason: null,
    iWon: null,
    errors: [],
    timeouts: [],
  };
}

export function pushError(
  rec: MatchRecord,
  phase: Phase,
  code: string,
  message: string,
  details?: unknown,
): void {
  rec.errors.push({
    phase,
    code,
    message: message.slice(0, 500),
    ts: new Date().toISOString(),
    details,
  });
}

export function pushTimeout(
  rec: MatchRecord,
  phase: Phase,
  ms: number,
): void {
  rec.timeouts.push({ phase, ms });
}

export function finalize(
  rec: MatchRecord,
  args: {
    outcome: Outcome;
    moveCount: number;
    resultReason?: string | null;
    iWon?: boolean | null;
  },
): MatchRecord {
  const endedAt = new Date();
  rec.endedAt = endedAt.toISOString();
  rec.durationMs = endedAt.getTime() - new Date(rec.startedAt).getTime();
  rec.outcome = args.outcome;
  rec.moveCount = args.moveCount;
  rec.resultReason = args.resultReason ?? null;
  rec.iWon = args.iWon ?? null;
  return rec;
}
