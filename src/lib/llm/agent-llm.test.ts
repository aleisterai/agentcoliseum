import { describe, expect, it } from "vitest";
import {
  AGENT_LLM_PROVIDER_IDS,
  defaultProviderFromClient,
  getAgentLlmProvider,
  isAgentLlmProviderId,
} from "./agent-llm";

describe("agent-llm registry", () => {
  it("includes MiniMax + the 6 hosted providers", () => {
    expect(AGENT_LLM_PROVIDER_IDS).toEqual([
      "anthropic",
      "openai",
      "gemini",
      "grok",
      "kimi",
      "deepseek",
      "minimax",
    ]);
  });
  it("isAgentLlmProviderId validates ids, not names", () => {
    expect(isAgentLlmProviderId("anthropic")).toBe(true);
    expect(isAgentLlmProviderId("minimax")).toBe(true);
    expect(isAgentLlmProviderId("Claude")).toBe(false); // display name, not id
    expect(isAgentLlmProviderId("skynet")).toBe(false);
    expect(isAgentLlmProviderId(null)).toBe(false);
  });
  it("getAgentLlmProvider returns name + maker, null for unknown", () => {
    expect(getAgentLlmProvider("anthropic")?.name).toBe("Claude");
    expect(getAgentLlmProvider("anthropic")?.maker).toBe("Anthropic");
    expect(getAgentLlmProvider("nope")).toBeNull();
    expect(getAgentLlmProvider(null)).toBeNull();
  });
});

describe("defaultProviderFromClient — soft default from MCP clientInfo", () => {
  it("maps single-model clients to their provider", () => {
    expect(defaultProviderFromClient("Claude Desktop")).toBe("anthropic");
    expect(defaultProviderFromClient("claude-ai")).toBe("anthropic");
    expect(defaultProviderFromClient("Claude Code")).toBe("anthropic");
    expect(defaultProviderFromClient("ChatGPT")).toBe("openai");
    expect(defaultProviderFromClient("Gemini CLI")).toBe("gemini");
    expect(defaultProviderFromClient("grok-cli")).toBe("grok");
  });
  it("returns null for multi-model clients (model not knowable from app name)", () => {
    for (const c of ["Cursor", "Cline", "Continue", "Windsurf", "Zed", "VS Code"]) {
      expect(defaultProviderFromClient(c), c).toBeNull();
    }
  });
  it("returns null for empty / missing", () => {
    expect(defaultProviderFromClient(undefined)).toBeNull();
    expect(defaultProviderFromClient(null)).toBeNull();
    expect(defaultProviderFromClient("")).toBeNull();
  });
});
