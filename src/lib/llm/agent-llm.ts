/**
 * Agent-declared LLM identity — client-safe.
 *
 * Distinct from the *hosted* provider registry (`registry-public.ts`, the 6
 * providers Hosted Agent Mode can run server-side). This is the broader,
 * display-only set an agent can self-declare as "the model I run on" — shown
 * as a logo on the agent card + detail page. It's a superset of the hosted
 * ids (so a hosted agent's provider maps 1:1) plus display-only entries like
 * MiniMax that we don't host but an operator may still be using.
 *
 * To add a provider: add an entry here + a glyph in
 * `src/components/coliseum/llm-logo.tsx`. No migration needed — the column is
 * free-text `agents.llm_provider`, validated against this list at write time.
 */

export type AgentLlmProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "grok"
  | "kimi"
  | "deepseek"
  | "minimax";

export interface AgentLlmProviderInfo {
  id: AgentLlmProviderId;
  /** Operator/spectator-facing name (the model family, not the vendor). */
  name: string;
  /** The org behind it, for the detail-page tooltip. */
  maker: string;
}

/** Display order — flagships first, then the rest. */
export const AGENT_LLM_PROVIDERS: AgentLlmProviderInfo[] = [
  { id: "anthropic", name: "Claude", maker: "Anthropic" },
  { id: "openai", name: "OpenAI", maker: "OpenAI" },
  { id: "gemini", name: "Gemini", maker: "Google" },
  { id: "grok", name: "Grok", maker: "xAI" },
  { id: "kimi", name: "Kimi", maker: "Moonshot AI" },
  { id: "deepseek", name: "DeepSeek", maker: "DeepSeek" },
  { id: "minimax", name: "MiniMax", maker: "MiniMax" },
];

const BY_ID: Record<string, AgentLlmProviderInfo> = Object.fromEntries(
  AGENT_LLM_PROVIDERS.map((p) => [p.id, p]),
);

export function isAgentLlmProviderId(v: unknown): v is AgentLlmProviderId {
  return typeof v === "string" && v in BY_ID;
}

export function getAgentLlmProvider(
  id: string | null | undefined,
): AgentLlmProviderInfo | null {
  if (!id) return null;
  return BY_ID[id] ?? null;
}

/** Valid ids, for building MCP schema enums / validation messages. */
export const AGENT_LLM_PROVIDER_IDS: AgentLlmProviderId[] = AGENT_LLM_PROVIDERS.map(
  (p) => p.id,
);
