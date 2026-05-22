/**
 * Per-move clock presets + validator. Pulled out of flow/lobby.ts so
 * unit tests don't have to spin up a DB to exercise the simple logic.
 *
 * **2026-05 second-pass recalibration (much more generous):** the
 * original 15/30/45/60s options assumed engine compute was the
 * bottleneck. The first recalibration to 60/120/180/300/600s helped,
 * but production data with Opus-class models (which run extended
 * thinking before emitting any tokens) still time-forfeited mid-
 * match. The current preset set doubles again to 120-1200s, with
 * per-game floors raised accordingly:
 *
 *   Simple    (tic-tac-toe, nim):  120s floor
 *   Medium    (connect4 et al):    240s floor
 *   Strategic (chess et al):       600s floor
 *
 * Reasoning is REQUIRED on every move (commit 01ec654), so the
 * budget has to accommodate the slowest model agents will reasonably
 * use. Faster models simply finish their move early — the clock is
 * a ceiling, not a target.
 *
 * Match the dropdown in the lobby create form + the `perMoveSeconds`
 * parameter on the MCP coliseum_challenge_propose tool:
 *
 *    120s — fast      (simple games; fast LLMs)
 *    240s — standard  (most games — the default)
 *    360s — long      (medium-complexity strategy)
 *    600s — deep      (chess, santorini, tak, quoridor)
 *   1200s — open      (extended-thinking models; tournaments; debug)
 *
 * The engine itself uses < 100ms even at hard depth. If these are
 * still tight, the bottleneck is your model's token-per-second rate
 * or extended-thinking budget, not the server.
 */

export const PER_MOVE_PRESETS = [120, 240, 360, 600, 1200] as const;
export type PerMoveSeconds = (typeof PER_MOVE_PRESETS)[number];
export const DEFAULT_PER_MOVE_SECONDS: PerMoveSeconds = 240;

export function isValidPerMoveSeconds(v: unknown): v is PerMoveSeconds {
  return (
    typeof v === "number" && (PER_MOVE_PRESETS as readonly number[]).includes(v)
  );
}

/**
 * Per-game recommended default. Used as the system-mode floor + as
 * the suggested preset when the lobby create form picks a game.
 * Bias generous — better to give the agent room than to forfeit a
 * polished reasoning into a stale clock.
 */
export function recommendedPerMoveSeconds(gameType: string): PerMoveSeconds {
  switch (gameType) {
    // Simple — minimax-trivial, branching is shallow. 120s still gives
    // an extended-thinking model plenty of room.
    case "tic-tac-toe":
    case "nim":
      return 120;
    // Medium — most games. Default 240s gives ~120s reasoning headroom
    // after state-read + composition.
    case "connect4":
    case "gomoku":
    case "mancala":
    case "dots-and-boxes":
    case "nine-mens-morris":
    case "hex":
    case "reversi":
      return 240;
    // Strategic — high branching, deep tactical lines. 600s lets the
    // agent actually search the position.
    case "chess":
    case "checkers":
    case "quoridor":
    case "santorini":
    case "tak":
      return 600;
    default:
      return DEFAULT_PER_MOVE_SECONDS;
  }
}
