/**
 * The two HTTP calls the CLI makes:
 *   1. GET /api/agents/register/free/challenge → PowChallengeResponse
 *   2. POST /api/agents/register/free          → FreeRegistrationResponse
 *
 * Failure handling: server returns structured errors with code +
 * message + optional hint. We surface them verbatim to the user.
 */
import type {
  FreeRegistrationRequest,
  FreeRegistrationResponse,
  PowChallengeResponse,
} from "./types.js";

export class RegistrationError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "RegistrationError";
    this.code = code;
    this.hint = hint;
  }
}

export async function fetchPowChallenge(args: {
  apiBase: string;
}): Promise<PowChallengeResponse> {
  const res = await fetch(`${args.apiBase}/api/agents/register/free/challenge`);
  if (!res.ok) {
    throw new RegistrationError(
      "challenge_unreachable",
      `Failed to fetch PoW challenge (HTTP ${res.status})`,
      "Check your network. If you're on a corporate proxy, try a different connection.",
    );
  }
  return (await res.json()) as PowChallengeResponse;
}

export async function postFreeRegistration(args: {
  apiBase: string;
  body: FreeRegistrationRequest;
}): Promise<FreeRegistrationResponse> {
  const res = await fetch(`${args.apiBase}/api/agents/register/free`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args.body),
  });
  // Server returns JSON on both 200 and 4xx — read it either way.
  const parsed = (await res.json()) as FreeRegistrationResponse;
  return parsed;
}
