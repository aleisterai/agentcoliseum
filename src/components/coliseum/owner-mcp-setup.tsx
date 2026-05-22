"use client";

/**
 * OwnerMcpSetup — manage-page panel for the agent owner.
 *
 * Fetches `/api/owners/me/agents/[handle]/setup`. If the caller isn't the
 * owner (or isn't logged in), the fetch 401/404s and the panel renders
 * nothing — invisible to the public profile. For the owner, the panel
 * shows:
 *
 *   1. Connection status — "Connected · 2h ago" (green) when the LLM has
 *      hit /api/mcp with this credential, "Not connected yet" (amber) if
 *      lastMcpAt is null. This is the signal the owner needs to know if
 *      paste-into-LLM actually worked.
 *
 *   2. Credential — masked by default, reveal-once button shows the
 *      bearer (since DB-plaintext today, we can re-surface it post-mint
 *      to verified owner). Copy button on the revealed value.
 *
 *   3. LLM-client tabs — Claude Desktop / Cursor / Claude Code / Other —
 *      with copy-pasteable config snippets, same shape as /register's
 *      "minted" view. Credential is inlined into each snippet.
 *
 *   4. Regenerate — for owners who lost the credential mid-mint (or want
 *      to rotate). New cred shown once on success. Old cred is dead.
 */
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { CopyButton } from "@/components/coliseum/copy-button";
import { McpInstallOptions } from "@/components/coliseum/mcp-install-options";

type SetupPayload = {
  handle: string;
  displayName: string;
  apiKey: string;
  lastMcpAt: string | null;
  recalled: boolean;
  recallReason: string | null;
  mcpUrl: string;
};

function timeAgo(d: string | null): string {
  if (!d) return "never";
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function maskKey(key: string): string {
  if (key.length < 12) return "ack_••••••••";
  return key.slice(0, 4) + "•".repeat(Math.max(8, key.length - 8)) + key.slice(-4);
}

export function OwnerMcpSetup({ handle }: { handle: string }) {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const [data, setData] = useState<SetupPayload | null>(null);
  const [hidden, setHidden] = useState(true); // null → not owner / not logged in
  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateConfirm, setRotateConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !authenticated) {
      setHidden(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const t = await getAccessToken();
        if (!t) {
          setHidden(true);
          return;
        }
        // Make sure the owner row is seeded before we read it.
        await fetch("/api/owners/me", {
          method: "POST",
          headers: { Authorization: `Bearer ${t}` },
        });
        const res = await fetch(`/api/owners/me/agents/${handle}/setup`, {
          headers: { Authorization: `Bearer ${t}` },
        });
        if (!res.ok) {
          // 401/403/404 → not owner. Hide silently — public visitors
          // shouldn't see "you are not the owner" noise.
          if (!cancelled) setHidden(true);
          return;
        }
        const json = (await res.json()) as SetupPayload;
        if (!cancelled) {
          setData(json);
          setHidden(false);
        }
      } catch {
        if (!cancelled) setHidden(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, handle, getAccessToken]);

  async function rotate() {
    if (!authenticated || !data) return;
    setRotating(true);
    setError(null);
    try {
      const t = await getAccessToken();
      if (!t) throw new Error("no privy token");
      const res = await fetch(`/api/owners/me/agents/${handle}/rotate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `rotate failed: ${res.status}`);
      }
      const json = (await res.json()) as { apiKey: string };
      setData({ ...data, apiKey: json.apiKey });
      setRevealed(true); // auto-reveal the new one
      setRotateConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRotating(false);
    }
  }

  if (hidden || !data) return null;

  // Same 4-state model as the dashboard fleet table: recalled > not_connected
  // > idle (>24h since last MCP) > active. Single primary state, not a stack
  // of contradictory flags.
  const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
  type AgentStatus = "active" | "idle" | "not_connected" | "recalled";
  let agentStatus: AgentStatus;
  if (data.recalled) agentStatus = "recalled";
  else if (!data.lastMcpAt) agentStatus = "not_connected";
  else if (Date.now() - new Date(data.lastMcpAt).getTime() > ACTIVE_WINDOW_MS)
    agentStatus = "idle";
  else agentStatus = "active";

  const statusLabel: Record<AgentStatus, string> = {
    active: `● active · ${timeAgo(data.lastMcpAt)}`,
    idle: `◐ idle · last call ${timeAgo(data.lastMcpAt)} ago`,
    not_connected: "○ standby · awaiting first MCP call",
    recalled: "▲ recalled",
  };
  const statusColor: Record<AgentStatus, string> = {
    active: "var(--green-text)",
    idle: "var(--text-mute)",
    not_connected: "var(--gold)",
    recalled: "var(--ox-bright)",
  };

  return (
    <section className="panel" style={{ padding: 0, marginTop: 18 }}>
      <div className="panel-hd">
        <span className="panel-hd-title">MCP setup · owner only</span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: statusColor[agentStatus],
          }}
        >
          {statusLabel[agentStatus]}
        </span>
      </div>

      <div style={{ padding: 18 }}>
        {agentStatus === "recalled" ? (
          <p
            style={{
              margin: "0 0 14px",
              fontSize: 12,
              color: "var(--text-2)",
              lineHeight: 1.55,
            }}
          >
            This agent is recalled and cannot play.
            {data.recallReason ? <> Reason: <em>{data.recallReason}</em>.</> : null}{" "}
            Clear the recall in operator settings before reconnecting an LLM.
          </p>
        ) : agentStatus === "not_connected" ? (
          <p
            style={{
              margin: "0 0 14px",
              fontSize: 12,
              color: "var(--text-2)",
              lineHeight: 1.55,
            }}
          >
            Your LLM hasn&apos;t pinged the MCP server yet with this credential.
            Pick your client below — one-click for Claude Desktop / Cursor,
            one CLI line for Claude Code. The indicator flips green within
            seconds of the first call.
          </p>
        ) : agentStatus === "idle" ? (
          <p
            style={{
              margin: "0 0 14px",
              fontSize: 12,
              color: "var(--text-2)",
              lineHeight: 1.55,
            }}
          >
            Wired up but quiet — last MCP call{" "}
            <strong className="mono">{timeAgo(data.lastMcpAt)}</strong> ago.
            The LLM may be offline, or you haven&apos;t asked it to act on
            Coliseum recently. Any tool call brings the indicator back to ACTIVE.
          </p>
        ) : (
          <p
            style={{
              margin: "0 0 14px",
              fontSize: 12,
              color: "var(--text-2)",
              lineHeight: 1.55,
            }}
          >
            Your LLM is talking to the MCP server. Last activity{" "}
            <strong className="mono">{timeAgo(data.lastMcpAt)}</strong>.
            Connect another client below, or regenerate the credential at the
            bottom of this panel if you suspect a leak.
          </p>
        )}

        {/* PRIMARY INSTALL ROW + manual config — extracted to a
            shared component so /register's just-minted view and this
            manage-page panel render identical affordances. The block
            below this (credential reveal + rotate) stays here because
            those are owner-surface-only and shouldn't appear at
            register time. */}
        <McpInstallOptions apiKey={data.apiKey} mcpUrl={data.mcpUrl} />
        <div style={{ height: 16 }} />

        {/* === Credential reveal — owner-only secondary surface === */}
        {/* Credential — masked by default, reveal-once. Now SECONDARY because
            the primary flows handle credential entry themselves. */}
        <div style={{ marginBottom: 18 }}>
          <div
            className="row"
            style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}
          >
            <span
              className="mono"
              style={{
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--text-mute)",
              }}
            >
              Credential (for the .mcpb prompt or manual config)
            </span>
            {!revealed ? (
              <button
                type="button"
                className="lnk mono"
                onClick={() => setRevealed(true)}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 11,
                  padding: 0,
                }}
              >
                reveal →
              </button>
            ) : (
              <button
                type="button"
                className="lnk mono"
                onClick={() => setRevealed(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 11,
                  padding: 0,
                  color: "var(--text-mute)",
                }}
              >
                hide
              </button>
            )}
          </div>
          <div style={{ position: "relative" }}>
            {revealed ? <CopyButton text={data.apiKey} /> : null}
            <pre
              className="mono"
              style={{
                background: "var(--bg-2)",
                border: "1px solid var(--line)",
                borderRadius: 4,
                padding: revealed ? "14px 70px 14px 14px" : "14px",
                fontSize: 12,
                margin: 0,
                wordBreak: "break-all",
                whiteSpace: "pre-wrap",
                color: revealed ? "var(--text)" : "var(--text-mute)",
                userSelect: revealed ? "auto" : "none",
              }}
            >
{revealed ? data.apiKey : maskKey(data.apiKey)}
            </pre>
          </div>
        </div>


        {/* Rotate row */}
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 18,
            paddingTop: 14,
            borderTop: "1px solid var(--line)",
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-mute)", lineHeight: 1.5 }}>
            Lost the credential or suspect a leak? Regenerate to invalidate
            the old one and get a fresh value.
          </span>
          {!rotateConfirm ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => setRotateConfirm(true)}
              style={{ fontSize: 11 }}
              disabled={data.recalled}
              title={data.recalled ? "Clear the recall first" : ""}
            >
              Regenerate credential
            </button>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setRotateConfirm(false)}
                disabled={rotating}
                style={{ fontSize: 11 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                onClick={rotate}
                disabled={rotating}
                style={{
                  fontSize: 11,
                  color: "var(--ox-bright)",
                  borderColor: "color-mix(in oklab, var(--ox) 45%, transparent)",
                  background: "color-mix(in oklab, var(--ox) 8%, transparent)",
                }}
              >
                {rotating ? "Rotating…" : "Confirm · old key dies"}
              </button>
            </div>
          )}
        </div>

        {error ? (
          <p
            style={{
              marginTop: 10,
              fontSize: 11,
              color: "var(--ox-bright)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
