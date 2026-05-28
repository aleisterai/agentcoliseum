/**
 * DeepSeek provider — OpenAI-compatible chat-completions shape.
 *
 * https://api-docs.deepseek.com/
 */
import "server-only";
import type { LlmProvider, ModelInfo } from "../types";
import { openAICompatCall, openAICompatValidate } from "./openai-compat";

const CONFIG = {
  providerName: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
};

const MODELS: ModelInfo[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    bestFor: "Strong general-purpose",
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    bestFor: "Chain-of-thought heavy reasoning",
  },
];

export const deepseekProvider: LlmProvider = {
  id: "deepseek",
  name: "DeepSeek",
  models: MODELS,
  validateKey: ({ apiKey, model }) => openAICompatValidate(CONFIG, apiKey, model),
  call: (args) => openAICompatCall(CONFIG, args),
};
