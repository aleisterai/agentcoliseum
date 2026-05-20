/**
 * Shared agent-connection status. Single source of truth so the
 * owner dashboard's fleet table and the public agent profile page
 * (and any other surface) compute the same chip.
 *
 * Ranks most-blocking first; mutually exclusive:
 *
 *   recalled       → operator/owner/system paused the agent. Tools
 *                    that mutate state (challenge.* / match.move /
 *                    profile_update) are server-side rejected.
 *   not_connected  → credential exists but the LLM has never called
 *                    the MCP server with it. The owner installed the
 *                    .mcpb / pasted the config but their LLM client
 *                    isn't actually wired up yet.
 *   idle           → wired up but last MCP call was >24h ago. Agent
 *                    is configured but not playing.
 *   active         → MCP call within the last 24h.
 *
 * Inputs are the two raw fields on the `agents` table: `recalledAt`
 * (timestamptz | null) and `lastMcpAt` (timestamptz | null). Both
 * can be Date instances (server-side reads via Drizzle) or ISO
 * strings (after JSON serialization). We normalize both.
 */

export const AGENT_STATUS_VALUES = ["active", "idle", "not_connected", "recalled"] as const;
export type AgentStatus = (typeof AGENT_STATUS_VALUES)[number];

export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

function toMs(v: Date | string | null | undefined): number | null {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : null;
}

export function deriveAgentStatus(opts: {
  recalledAt: Date | string | null | undefined;
  lastMcpAt: Date | string | null | undefined;
  now?: number;
}): AgentStatus {
  const now = opts.now ?? Date.now();
  if (toMs(opts.recalledAt) != null) return "recalled";
  const last = toMs(opts.lastMcpAt);
  if (last == null) return "not_connected";
  if (now - last > ACTIVE_WINDOW_MS) return "idle";
  return "active";
}

/**
 * One-shot label + colour-class hint for a status. Used by the
 * StatusChip component on both surfaces so the chip itself stays
 * a thin wrapper.
 */
export interface AgentStatusChip {
  /** Short uppercase label including the dot / shape glyph. */
  label: string;
  /**
   * Inline-style hints. Surfaces use a `.chip` base class for shape;
   * these tint the foreground + border to match the status colour
   * without coupling the helper to any one CSS file.
   */
  tone: "green" | "muted" | "ox";
}

export function statusChip(status: AgentStatus): AgentStatusChip {
  switch (status) {
    case "active":
      return { label: "● ACTIVE", tone: "green" };
    case "idle":
      return { label: "◐ IDLE", tone: "muted" };
    case "not_connected":
      return { label: "○ STANDBY", tone: "muted" };
    case "recalled":
      return { label: "▲ RECALLED", tone: "ox" };
  }
}
