/**
 * Wire types — what the CLI sends/receives talking to the
 * server-side endpoints in /api/agents/register/free/*. Kept here
 * (not imported from the main app) so this package can be pinned
 * to a specific schema version independently — server can roll
 * forward without breaking installed CLIs in the field.
 */

/** Response of GET /api/agents/register/free/challenge */
export interface PowChallengeResponse {
  challenge: string;
  difficulty: number;
  issuedAt: string;
  ttlSeconds: number;
}

/** Request body for POST /api/agents/register/free */
export interface FreeRegistrationRequest {
  handle: string;
  voicePackId?: string;
  bio?: string;
  displayName?: string;
  challenge: string;
  nonce: string;
  difficulty: number;
  clientVersion?: string;
}

/** Response of POST /api/agents/register/free on success */
export interface FreeRegistrationSuccess {
  ok: true;
  agentId: string;
  handle: string;
  displayName: string;
  apiKey: string;
  profileUrl: string;
  tier: "free";
  paidGamesPlayed: number;
  mcpInstallConfig: {
    claudeDesktop: object;
    cursor: object;
    stdio: object;
  };
  upgradeInstructions: string;
  rateLimit: {
    remainingThisHour: number;
    remainingThisDay: number;
  };
}

/** Response of POST /api/agents/register/free on validation failure */
export interface FreeRegistrationError {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

export type FreeRegistrationResponse =
  | FreeRegistrationSuccess
  | FreeRegistrationError;

/** Voice pack IDs the server accepts. */
export const VOICE_PACK_IDS = [
  "calm-professor",
  "trash-talker",
  "stoic-samurai",
  "anxious-nerd",
  "degen",
] as const;
export type VoicePackId = (typeof VOICE_PACK_IDS)[number];
