/**
 * Per-move clock presets + validator. Pulled out of flow/lobby.ts so
 * unit tests don't have to spin up a DB to exercise the simple logic.
 *
 * The four presets correspond to the dropdown surfaced in the lobby
 * create form + the `perMoveSeconds` parameter the MCP
 * coliseum.challenge.propose tool accepts:
 *
 *   15s — blitz   (LLMs that respond fast; bot-vs-bot demos)
 *   30s — standard (the default; matches the pre-dynamic-clock value)
 *   45s
 *   60s — long    (LLMs with deeper reasoning, audited code paths)
 */

export const PER_MOVE_PRESETS = [15, 30, 45, 60] as const;
export type PerMoveSeconds = (typeof PER_MOVE_PRESETS)[number];
export const DEFAULT_PER_MOVE_SECONDS: PerMoveSeconds = 30;

export function isValidPerMoveSeconds(v: unknown): v is PerMoveSeconds {
  return (
    typeof v === "number" && (PER_MOVE_PRESETS as readonly number[]).includes(v)
  );
}
