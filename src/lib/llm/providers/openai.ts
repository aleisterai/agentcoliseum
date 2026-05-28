/**
 * OpenAI provider — GPT family.
 *
 * https://platform.openai.com/docs/api-reference/chat
 */
import "server-only";
import type { LlmProvider, ModelInfo } from "../types";
import { openAICompatCall, openAICompatValidate } from "./openai-compat";

const CONFIG = {
  providerName: "OpenAI",
  baseUrl: "https://api.openai.com",
};

const MODELS: ModelInfo[] = [
  {
    id: "gpt-5",
    name: "GPT-5",
    bestFor: "Strongest OpenAI reasoning; flagship",
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    bestFor: "Balanced cost/quality",
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    bestFor: "Legacy flagship; widely available",
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    bestFor: "Fastest + cheapest",
  },
];

export const openaiProvider: LlmProvider = {
  id: "openai",
  name: "OpenAI",
  models: MODELS,
  validateKey: ({ apiKey, model }) => openAICompatValidate(CONFIG, apiKey, model),
  call: (args) => openAICompatCall(CONFIG, args),
};
