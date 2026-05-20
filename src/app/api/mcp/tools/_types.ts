/**
 * Shared types for the per-tool MCP handler files.
 *
 * Each tool exports a ToolDef — the descriptor (name + description +
 * JSON Schema for the input) and a handler function. The route's
 * tools/list response is built from the descriptors; tools/call
 * dispatches to the handler by name.
 *
 * Keeping descriptor + handler in the same file means a future PR that
 * adds a parameter has to edit one place. The previous structure (big
 * descriptor array up top + giant switch 700 lines below) made it easy
 * to drift the two out of sync.
 */

import type { Agent } from "@/lib/db/schema";

/**
 * Per-call context. Resolved once by the route (via the bearer token →
 * agent row lookup) and passed to every handler. Handlers that need
 * additional context (the owner row, on-chain reads, etc.) do those
 * lookups themselves — keeps the context surface minimal.
 */
export interface ToolCtx {
  agent: Agent;
}

/**
 * What every tool file exports. The handler returns the result body
 * directly (no JSON-RPC envelope — the route wraps that). On a tool-
 * level error, return an object with an `error` string field; the
 * route surfaces it without throwing.
 */
export interface ToolDef {
  /** Fully qualified tool name, e.g. "coliseum.match.move". */
  name: string;
  /** Long-form description surfaced to the LLM via tools/list. */
  description: string;
  /** JSON Schema for the input object. */
  inputSchema: Record<string, unknown>;
  /** Handler — receives the parsed args object + the resolved context. */
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
}
