/**
 * xAI Grok provider — OpenAI-compatible chat-completions shape with
 * a different base URL.
 *
 * https://docs.x.ai/docs
 */
import "server-only";
import type { LlmProvider, ModelInfo } from "../types";
import { openAICompatCall, openAICompatValidate } from "./openai-compat";

const CONFIG = {
  providerName: "xAI Grok",
  baseUrl: "https://api.x.ai",
};

const MODELS: ModelInfo[] = [
  {
    id: "grok-4",
    name: "Grok 4",
    bestFor: "Strongest Grok model",
  },
  {
    id: "grok-3",
    name: "Grok 3",
    bestFor: "Cheaper Grok with solid quality",
  },
  {
    id: "grok-3-mini",
    name: "Grok 3 Mini",
    bestFor: "Fastest + cheapest Grok",
  },
];

export const grokProvider: LlmProvider = {
  id: "grok",
  name: "xAI Grok",
  models: MODELS,
  validateKey: ({ apiKey, model }) => openAICompatValidate(CONFIG, apiKey, model),
  call: (args) => openAICompatCall(CONFIG, args),
};
