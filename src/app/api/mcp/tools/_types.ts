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
/**
 * MCP tool annotations (https://modelcontextprotocol.io/specification/server/tools#annotations).
 *
 * Claude clients (Claude Desktop, Claude.ai web Custom Connectors, etc.)
 * use these hints to pick the DEFAULT permission for a tool on first
 * install. Without annotations the client falls back to "ask before
 * each call" — that's why early users were getting permission prompts
 * mid-match on coliseum_match_move and friends, blowing the per-move
 * clock while they hunted for the Allow button.
 *
 * Setting `destructiveHint: false` on every Coliseum tool flips the
 * default from "ask" to "always allow" in the client UI. None of our
 * tools delete anything irreversibly — the worst a mutation can do is
 * create a match row, advance a turn, or move USDC the owner already
 * explicitly funded the agent with under caps the owner set in advance.
 */
export interface ToolAnnotations {
  /** Human-readable name shown in the client permission UI. */
  title?: string;
  /** True if the tool only reads (no DB / on-chain writes). */
  readOnlyHint?: boolean;
  /** True if the tool may delete or irreversibly modify data. */
  destructiveHint?: boolean;
  /** True if calling the tool repeatedly with the same args has the same effect as one call. */
  idempotentHint?: boolean;
  /** True if the tool interacts with the open internet (HTTP, blockchain RPC, etc.). */
  openWorldHint?: boolean;
}

export interface ToolDef {
  /** Fully qualified tool name, e.g. "coliseum_match_move". */
  name: string;
  /** Long-form description surfaced to the LLM via tools/list. */
  description: string;
  /** JSON Schema for the input object. */
  inputSchema: Record<string, unknown>;
  /** Per-MCP-spec annotations used by clients to pick a default permission. */
  annotations?: ToolAnnotations;
  /**
   * Tier gate (2026-05, two-tier onboarding).
   *
   * If true, the route dispatcher calls `requirePlayAccess(agent)`
   * BEFORE the handler — checking the agent's linked wallet has
   * ≥20M $ALEISTER (Play tier) AND `paidGamesPlayed < 5` OR ≥50M
   * (Initiator tier). On rejection the dispatcher returns a
   * canonical `{ok:false, error:{code:'tier_below_*' | 'no_wallet_linked', ...}}`
   * envelope without calling the handler — the agent gets a clean
   * error with the linked-wallet balance + upgrade hint.
   *
   * Tools that allow free-mode bypass (challenge_propose with
   * args.mode='free', match_move on a free-mode match) declare
   * `freeModeAllowed: true` AND a custom inspection function
   * `freeModeArgs` that the dispatcher uses to decide whether the
   * specific call qualifies for the bypass. If `freeModeArgs`
   * returns true, the tier gate is skipped.
   */
  paidPlayRequired?: boolean;
  /**
   * Inspect parsed args to decide whether this specific call is
   * free-mode (and therefore bypasses paidPlayRequired). Only
   * meaningful when paidPlayRequired is true.
   */
  freeModeArgs?: (args: unknown) => boolean;
  /** Handler — receives the parsed args object + the resolved context. */
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
}
