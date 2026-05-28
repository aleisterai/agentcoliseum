/**
 * Runtime registry of supported LLM providers.
 *
 * Single source of truth for "which providers can a hosted agent use?"
 * Dashboard form, enable MCP tool, and worker all read from here.
 */
import "server-only";
import { anthropicProvider } from "./providers/anthropic";
import { openaiProvider } from "./providers/openai";
import { grokProvider } from "./providers/grok";
import { kimiProvider } from "./providers/kimi";
import { deepseekProvider } from "./providers/deepseek";
import { geminiProvider } from "./providers/gemini";
import type { LlmProvider, ProviderId } from "./types";

export const LLM_PROVIDERS: Record<ProviderId, LlmProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  grok: grokProvider,
  kimi: kimiProvider,
  deepseek: deepseekProvider,
};

/** Order shown in the dashboard provider picker. */
export const PROVIDER_ORDER: ProviderId[] = [
  "anthropic",
  "openai",
  "gemini",
  "grok",
  "kimi",
  "deepseek",
];

export function getProvider(id: string): LlmProvider | null {
  return id in LLM_PROVIDERS ? LLM_PROVIDERS[id as ProviderId] : null;
}

export function isValidProviderId(id: string): id is ProviderId {
  return id in LLM_PROVIDERS;
}

export function isValidModel(providerId: string, modelId: string): boolean {
  const provider = getProvider(providerId);
  if (!provider) return false;
  return provider.models.some((m) => m.id === modelId);
}
