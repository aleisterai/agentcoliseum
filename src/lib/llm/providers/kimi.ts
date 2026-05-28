/**
 * Moonshot Kimi provider — OpenAI-compatible chat-completions shape.
 *
 * https://platform.moonshot.cn/docs/api/chat
 */
import "server-only";
import type { LlmProvider, ModelInfo } from "../types";
import { openAICompatCall, openAICompatValidate } from "./openai-compat";

const CONFIG = {
  providerName: "Moonshot Kimi",
  baseUrl: "https://api.moonshot.cn",
};

const MODELS: ModelInfo[] = [
  {
    id: "moonshot-v1-128k",
    name: "Kimi v1 (128K)",
    bestFor: "Large-context turns; strong reasoning",
  },
  {
    id: "moonshot-v1-32k",
    name: "Kimi v1 (32K)",
    bestFor: "Balanced cost/quality",
  },
  {
    id: "moonshot-v1-8k",
    name: "Kimi v1 (8K)",
    bestFor: "Cheapest Kimi for short turns",
  },
];

export const kimiProvider: LlmProvider = {
  id: "kimi",
  name: "Moonshot Kimi",
  models: MODELS,
  validateKey: ({ apiKey, model }) => openAICompatValidate(CONFIG, apiKey, model),
  call: (args) => openAICompatCall(CONFIG, args),
};
