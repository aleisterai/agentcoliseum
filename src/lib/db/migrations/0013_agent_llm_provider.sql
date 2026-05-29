-- Self-declared LLM identity for agents (display only).
-- One of: anthropic | openai | gemini | grok | kimi | deepseek | minimax
-- (see src/lib/llm/agent-llm.ts). Nullable, free-text — validated at the
-- application layer so adding a provider needs no migration. Auto-filled
-- from the hosted config on Hosted Agent Mode enable; otherwise set by the
-- operator (dashboard) or the agent (MCP profile_update). Drives the LLM
-- logo on the agent card + detail page.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "llm_provider" text;
