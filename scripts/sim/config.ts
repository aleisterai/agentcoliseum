/**
 * Static config knobs for the sim. Default target = production. Override
 * with env vars when running against staging / a feature branch / a
 * tunneled localhost.
 */

export const ORIGIN: string =
  process.env.SIM_ORIGIN ?? "https://www.agentcoliseum.xyz";

/** Per-HTTP-call timeout. The long-poll match/state hangs up to
 *  waitMs=50_000, so we floor this above that with a safety margin. */
export const FETCH_TIMEOUT_MS: number = Number(
  process.env.SIM_FETCH_TIMEOUT_MS ?? 70_000,
);

/** Default long-poll waitMs for match/state. The MCP-versioned
 *  endpoint wakes within ~3s under load now; 50s gives generous slack. */
export const STATE_WAIT_MS: number = Number(
  process.env.SIM_STATE_WAIT_MS ?? 50_000,
);

/** Cap a single match's wall-clock lifetime in the runner. Beyond this
 *  we forcibly mark the match as a sim-side timeout and stop polling. */
export const MATCH_HARD_DEADLINE_MS: number = Number(
  process.env.SIM_MATCH_DEADLINE_MS ?? 5 * 60_000,
);

/** Cap how many moves a single match can take before we bail. Some
 *  games (chess, gomoku) can hit 80+ moves; allow plenty of headroom. */
export const MAX_MOVES_PER_MATCH: number = Number(
  process.env.SIM_MAX_MOVES ?? 200,
);

/** Per-move clock budget we ask for at propose time. The endpoint
 *  enforces a per-game floor; we just pick a generous ceiling so the
 *  sim doesn't flake on a slow long-poll round-trip. */
export const PER_MOVE_SECONDS: 120 | 240 | 360 | 600 | 1200 = (() => {
  const raw = Number(process.env.SIM_PER_MOVE_SECONDS ?? 120);
  if (raw === 120 || raw === 240 || raw === 360 || raw === 600 || raw === 1200) {
    return raw;
  }
  return 120;
})();

/** Test agent bearer tokens. The handles are mcp-duel-alpha /
 *  mcp-duel-beta (already seeded with a known voice pack — see
 *  pnpm mcp:duel). Override via env if you've rotated keys.
 *
 *  These are throwaway free-tier test agents — no real funds.
 */
export const ALPHA_KEY: string =
  process.env.SIM_ALPHA_KEY ??
  process.env.ALPHA_API_KEY ??
  "ack_jAOqtxj64dTQhW2hbMwKOSKA5ZVZJPt7dPl-m2JVR7c";
export const BETA_KEY: string =
  process.env.SIM_BETA_KEY ??
  process.env.BETA_API_KEY ??
  "ack_hy2F2T0COtMhXQSdqj3zElz5aGlKUKX_YLNewMhN0R8";
