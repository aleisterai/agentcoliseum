/**
 * Client-safe LLM provider metadata.
 *
 * Mirrors src/lib/llm/registry.ts (which is `import "server-only"` —
 * it pulls in network call paths, server crypto, etc.) but exposes
 * ONLY the static metadata the dashboard form needs:
 *   - provider id / display name
 *   - model id / display name / bestFor hint
 *
 * No API call surface. The form posts the user's choice to the
 * server route; the server consults the real registry to validate
 * and dispatch.
 *
 * Keep this in lockstep with the provider files when you add a model
 * or a provider — there's no automatic check.
 */

export type ProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "grok"
  | "kimi"
  | "deepseek";

export interface PublicModelInfo {
  id: string;
  name: string;
  bestFor?: string;
}

export interface PublicProviderInfo {
  id: ProviderId;
  name: string;
  models: PublicModelInfo[];
}

export const LLM_PROVIDERS: Record<ProviderId, PublicProviderInfo> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic Claude",
    models: [
      {
        id: "claude-opus-4-7-20260101",
        name: "Claude Opus 4.7",
        bestFor: "Strongest reasoning; flagship",
      },
      {
        id: "claude-sonnet-4-5-20251101",
        name: "Claude Sonnet 4.5",
        bestFor: "Balanced cost/quality",
      },
      {
        id: "claude-haiku-4-20250801",
        name: "Claude Haiku 4",
        bestFor: "Fastest + cheapest",
      },
    ],
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-5", name: "GPT-5", bestFor: "Strongest OpenAI; flagship" },
      { id: "gpt-5-mini", name: "GPT-5 Mini", bestFor: "Balanced cost/quality" },
      { id: "gpt-4.1", name: "GPT-4.1", bestFor: "Legacy flagship" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", bestFor: "Fastest + cheapest" },
    ],
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", bestFor: "Strongest Gemini" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", bestFor: "Balanced" },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", bestFor: "Cheapest" },
    ],
  },
  grok: {
    id: "grok",
    name: "xAI Grok",
    models: [
      { id: "grok-4", name: "Grok 4", bestFor: "Strongest Grok" },
      { id: "grok-3", name: "Grok 3", bestFor: "Cheaper alternative" },
      { id: "grok-3-mini", name: "Grok 3 Mini", bestFor: "Fastest" },
    ],
  },
  kimi: {
    id: "kimi",
    name: "Moonshot Kimi",
    models: [
      { id: "moonshot-v1-128k", name: "Kimi v1 (128K)", bestFor: "Large context" },
      { id: "moonshot-v1-32k", name: "Kimi v1 (32K)", bestFor: "Balanced" },
      { id: "moonshot-v1-8k", name: "Kimi v1 (8K)", bestFor: "Cheapest" },
    ],
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", bestFor: "General-purpose" },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", bestFor: "Chain-of-thought" },
    ],
  },
};

export const PROVIDER_ORDER: ProviderId[] = [
  "anthropic",
  "openai",
  "gemini",
  "grok",
  "kimi",
  "deepseek",
];
