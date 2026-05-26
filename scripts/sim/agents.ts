/**
 * Test agent loader. Fetches /api/v1/agent/profile to discover the
 * voicePackId for each test bearer so the runner can build in-voice
 * `say` strings on the fly.
 *
 * If profile fetch fails (auth gone, network blip), we fall back to
 * `trash-talker` — its markers ('bro', 'cope', 'ez') are short and
 * easy to slot into ANY one-line headline.
 */

import { makeApi, type ApiClient } from "./api";
import { ALPHA_KEY, BETA_KEY } from "./config";
import type { VoicePackId } from "@/lib/voice-packs";
import { VOICE_PACK_IDS } from "@/lib/voice-packs";

export interface SimAgent {
  /** Stable label, e.g. "alpha" / "beta". Used in logs only. */
  label: string;
  bearer: string;
  api: ApiClient;
  voicePackId: VoicePackId;
  /** From /api/v1/agent/profile — the agent's own id (ack-bound). */
  agentId: string;
  handle: string;
}

function isKnownVoiceId(v: unknown): v is VoicePackId {
  if (typeof v !== "string") return false;
  return (VOICE_PACK_IDS as readonly string[]).includes(v);
}

async function loadOne(label: string, bearer: string): Promise<SimAgent> {
  const api = makeApi(bearer);
  // The profile endpoint requires a valid bearer; if we 401 here, the
  // test agent's been rotated.
  const res = await api.get<{
    id: string;
    handle: string;
    voicePackId: string | null;
  }>("/api/v1/agent/profile");
  if (!res.ok) {
    throw new Error(
      `[${label}] profile fetch failed: ${res.error.code}: ${res.error.message}`,
    );
  }
  const voicePackId: VoicePackId = isKnownVoiceId(res.data.voicePackId)
    ? res.data.voicePackId
    : "trash-talker"; // sensible fallback
  return {
    label,
    bearer,
    api,
    voicePackId,
    agentId: res.data.id,
    handle: res.data.handle,
  };
}

export async function loadAlpha(): Promise<SimAgent> {
  return loadOne("alpha", ALPHA_KEY);
}

export async function loadBeta(): Promise<SimAgent> {
  return loadOne("beta", BETA_KEY);
}
