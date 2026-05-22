/**
 * Per-move clock presets + validator. Pulled out of flow/lobby.ts so
 * unit tests don't have to spin up a DB to exercise the simple logic.
 *
 * **2026-05 budget recalibration:** the original 15/30/45/60s
 * options were set assuming engine compute was the bottleneck (the
 * code-comments around this module still reference 30s as the
 * "spectator pacing" target — those are now stale and shouldn't be
 * trusted; see per-move.ts for the canonical values). In
 * practice, LLM token generation dominates wall-clock — a typical
 * move runs ~45-80s (state-read round-trip + reasoning generation +
 * move composition + network). Old 60s "long" preset gave zero
 * safety margin; empirical forfeit rate hit 66%.
 *
 * New presets are 3-5x more generous. Match the dropdown in the
 * lobby create form + the `perMoveSeconds` parameter on the MCP
 * coliseum_challenge_propose tool:
 *
 *    60s — fast      (simple games like tic-tac-toe, nim)
 *   120s — standard  (most games — the default)
 *   180s — long      (medium-complexity strategy)
 *   300s — deep      (chess, santorini, tak, quoridor; the heavy thinkers)
 *   600s — open      (turn-the-clock-off: bot-vs-bot research, debug)
 *
 * Reasoning generation eats most of the budget; the engine itself
 * uses < 100ms even at hard depth. If you find these still too
 * tight, the bottleneck is your model's token-per-second rate, not
 * the engine.
 */

export const PER_MOVE_PRESETS = [60, 120, 180, 300, 600] as const;
export type PerMoveSeconds = (typeof PER_MOVE_PRESETS)[number];
export const DEFAULT_PER_MOVE_SECONDS: PerMoveSeconds = 120;

export function isValidPerMoveSeconds(v: unknown): v is PerMoveSeconds {
  return (
    typeof v === "number" && (PER_MOVE_PRESETS as readonly number[]).includes(v)
  );
}

/**
 * Per-game recommended default. Used as the system-mode floor + as
 * the suggested preset when the lobby create form picks a game.
 * Bias slightly conservative — better to give the agent room than
 * to forfeit a polished reasoning into a stale clock.
 */
export function recommendedPerMoveSeconds(gameType: string): PerMoveSeconds {
  switch (gameType) {
    // Simple — minimax-trivial, branching is shallow.
    case "tic-tac-toe":
    case "nim":
      return 60;
    // Medium — most games. Default 120s gives ~60s reasoning headroom.
    case "connect4":
    case "gomoku":
    case "mancala":
    case "dots-and-boxes":
    case "nine-mens-morris":
    case "hex":
    case "reversi":
      return 120;
    // Strategic — high branching, deep tactical lines, agents
    // genuinely need to think.
    case "chess":
    case "checkers":
    case "quoridor":
    case "santorini":
    case "tak":
      return 300;
    default:
      return DEFAULT_PER_MOVE_SECONDS;
  }
}
