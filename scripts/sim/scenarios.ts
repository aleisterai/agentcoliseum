/**
 * scenarios.ts — declarative list of what to exercise.
 *
 * A "scenario" is a (gameType, opponent, mode, count, twist) tuple
 * the runner can iterate over to produce N MatchRecords. The CLI
 * selects subsets via flags (--games, --matches, --difficulty,
 * --opponent).
 *
 * Twists exercise specific failure paths in addition to the happy
 * playthrough:
 *   'happy'        — play to natural finish (win/loss/draw)
 *   'invalid_3x'   — submit malformed payload 3 times to force the
 *                    2-strike (or 3-strike) illegal-move forfeit
 *   'resign_mid'   — call /v1/match/move with a malformed payload
 *                    until forced forfeit. (There's no first-class
 *                    'resign' endpoint as of 2026-05; the brief asks
 *                    us to test the abandon path if it exists. We
 *                    fall back to invalid_3x since it terminates
 *                    server-side cleanly.)
 */

import type { GameId } from "./movers";
import { ALL_GAMES } from "./movers";

export type SimDifficulty = "easy" | "medium" | "hard";
export type SimOpponent = "system_bot";
export type SimMode = "free" | "system" | "paid";

export type Twist = "happy" | "invalid_3x" | "resign_mid";

export interface Scenario {
  id: string;
  gameType: GameId;
  opponent: SimOpponent;
  difficulty: SimDifficulty;
  /**
   * Propose mode: 'system' for one-step system-bot match (this is the
   * only mode that auto-activates without a 2nd agent's acceptance).
   * Reserving 'free' for future agent-vs-agent. For now we treat them
   * as synonyms because the brief's "mode: free" with a system_bot
   * opponent maps to the 'system' API mode.
   */
  mode: SimMode;
  twist: Twist;
  count: number;
}

export interface ScenarioBuilderArgs {
  /** Subset of games to include. Defaults to ALL_GAMES. */
  games?: GameId[];
  /** Matches per scenario. The smoke-mode default is 5; bumped to
   *  20 for the v1 sweep, 60 for the 1000-match run. */
  matches?: number;
  /** Override the difficulty for the main happy-path sweep. */
  difficulty?: SimDifficulty;
  /** Skip the invalid-payload + resign-mid scenarios (smoke runs
   *  usually want only the happy path). */
  twistsOff?: boolean;
}

export function buildScenarios(args: ScenarioBuilderArgs = {}): Scenario[] {
  const games = args.games ?? ALL_GAMES;
  const matches = args.matches ?? 20;
  const difficulty = args.difficulty ?? "easy";
  const twistsOff = args.twistsOff ?? false;

  const scenarios: Scenario[] = [];

  // (1) happy-path sweep per game
  for (const gameType of games) {
    scenarios.push({
      id: `${gameType}-${difficulty}-happy`,
      gameType,
      opponent: "system_bot",
      difficulty,
      mode: "system",
      twist: "happy",
      count: matches,
    });
  }

  if (twistsOff) return scenarios;

  // (2) hard-difficulty challenge subset — only games where the hard
  // bot is interesting enough to surface edge cases (tic-tac-toe,
  // connect4, chess all have hard bots with real depth).
  const hardCandidates: GameId[] = ["tic-tac-toe", "connect4", "chess"];
  const hardSubset: GameId[] = hardCandidates.filter((g) =>
    games.includes(g),
  );
  for (const gameType of hardSubset) {
    scenarios.push({
      id: `${gameType}-hard-happy`,
      gameType,
      opponent: "system_bot",
      difficulty: "hard",
      mode: "system",
      twist: "happy",
      count: 10,
    });
  }

  // (3) invalid-move forfeit on tic-tac-toe (small, fast cycles)
  if (games.includes("tic-tac-toe")) {
    scenarios.push({
      id: `tic-tac-toe-easy-invalid-3x`,
      gameType: "tic-tac-toe",
      opponent: "system_bot",
      difficulty: "easy",
      mode: "system",
      twist: "invalid_3x",
      count: 5,
    });
  }

  // (4) resign-mid (alias for invalid_3x today — see Twist doc above)
  for (const gameType of ["tic-tac-toe", "connect4"] as GameId[]) {
    if (!games.includes(gameType)) continue;
    scenarios.push({
      id: `${gameType}-easy-resign-mid`,
      gameType,
      opponent: "system_bot",
      difficulty: "easy",
      mode: "system",
      twist: "resign_mid",
      count: 5,
    });
  }

  return scenarios;
}
