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

type SetupPayload = {
  handle: string;
  displayName: string;
  apiKey: string;
  lastMcpAt: string | null;
  recalled: boolean;
  recallReason: string | null;
  mcpUrl: string;
};

type LlmKind = "claude-desktop" | "cursor" | "claude-code" | "other";

const LLM_OPTIONS: Array<{ id: LlmKind; label: string; hint: string }> = [
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    hint:
      "~/Library/Application Support/Claude/claude_desktop_config.json  (macOS)  ·  %APPDATA%\\Claude\\claude_desktop_config.json  (Windows)",
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: "~/.cursor/mcp.json   (or `.cursor/mcp.json` in a workspace)",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Run the command below in your terminal — Claude Code persists it for you.",
  },
  {
    id: "other",
    label: "Other (Eliza / OpenClaw / ChatGPT MCP)",
    hint: "Standard remote-MCP JSON shape — wherever your client reads its server config.",
  },
];

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
  const [llm, setLlm] = useState<LlmKind>("claude-desktop");
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

  const httpConfig = JSON.stringify(
    {
      mcpServers: {
        coliseum: {
          url: data.mcpUrl,
          headers: { Authorization: `Bearer ${data.apiKey}` },
        },
      },
    },
    null,
    2,
  );

  const claudeCodeCmd = `claude mcp add coliseum --transport http ${data.mcpUrl} --header "Authorization: Bearer ${data.apiKey}"`;

  const stdioConfig = JSON.stringify(
    {
      mcpServers: {
        coliseum: {
          command: "node",
          args: ["~/.coliseum/coliseum-mcp.mjs"],
          env: { COLISEUM_API_KEY: data.apiKey },
        },
      },
    },
    null,
    2,
  );

  // Cursor one-click deeplink. Encodes the single MCP server config (the
  // value Cursor would otherwise want in ~/.cursor/mcp.json under
  // mcpServers.coliseum). Cursor opens an install dialog with this filled in.
  // Spec: cursor://anysphere.cursor-deeplink/mcp/install?name=&config=<base64>
  const cursorPayload =
    typeof window !== "undefined"
      ? window.btoa(
          JSON.stringify({
            url: data.mcpUrl,
            headers: { Authorization: `Bearer ${data.apiKey}` },
          }),
        )
      : "";
  const cursorDeeplink = `cursor://anysphere.cursor-deeplink/mcp/install?name=coliseum&config=${cursorPayload}`;

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

  const llmInfo = LLM_OPTIONS.find((o) => o.id === llm) ?? LLM_OPTIONS[0];

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

        {/* PRIMARY INSTALL ROW — three buttons. The big one ships a real
            one-liner on the two clients with native install dialogs. */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 10,
            marginBottom: 16,
          }}
        >
          {/* Claude Desktop — .mcpb bundle. Double-click installs in app. */}
          <a
            className="btn"
            href="/coliseum.mcpb"
            download="coliseum.mcpb"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              padding: "12px 14px",
              textDecoration: "none",
              color: "var(--gold)",
              borderColor: "color-mix(in oklab, var(--gold) 45%, transparent)",
              background: "color-mix(in oklab, var(--gold) 8%, transparent)",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>Download for Claude</span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "color-mix(in oklab, var(--gold) 60%, var(--text-mute))",
                marginTop: 2,
                letterSpacing: "0.05em",
              }}
            >
              .mcpb · double-click · paste key
            </span>
          </a>

          {/* Cursor — deeplink. Opens Cursor with prefilled install dialog. */}
          <a
            className="btn"
            href={cursorDeeplink}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              padding: "12px 14px",
              textDecoration: "none",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>Add to Cursor</span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--text-mute)",
                marginTop: 2,
                letterSpacing: "0.05em",
              }}
            >
              one-click · key embedded
            </span>
          </a>

          {/* Claude Code — single CLI command, copy & run. */}
          <button
            type="button"
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(claudeCodeCmd);
              setRevealed(true);
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              padding: "12px 14px",
              textAlign: "left",
              cursor: "pointer",
            }}
            title="Copy the `claude mcp add` command"
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>Copy for Claude Code</span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--text-mute)",
                marginTop: 2,
                letterSpacing: "0.05em",
              }}
            >
              one CLI line · paste in terminal
            </span>
          </button>
        </div>

        <p
          style={{
            fontSize: 11,
            color: "var(--text-mute)",
            lineHeight: 1.5,
            margin: "0 0 16px",
          }}
        >
          The <strong>.mcpb</strong> is Anthropic&apos;s official Claude Desktop bundle format —
          download it, open the file, Claude prompts you for the credential below
          (stored encrypted in your OS keychain). The Cursor deeplink embeds the
          credential and pre-fills the install dialog.
        </p>

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

        {/* Manual config — collapsed. For everything that isn't Claude Desktop
            / Cursor / Claude Code (Eliza, ChatGPT MCP, OpenClaw, generic). */}
        <details style={{ marginTop: 6 }}>
          <summary
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--text-mute)",
              cursor: "pointer",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            Manual config (Eliza · ChatGPT MCP · OpenClaw · generic)
          </summary>
          <div style={{ marginTop: 12 }}>
            {/* LLM client tabs */}
            <div className="tabbar" style={{ marginBottom: 10 }}>
              {LLM_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  className={llm === opt.id ? "tab on" : "tab"}
                  onClick={() => setLlm(opt.id)}
                  type="button"
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <p
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--text-mute)",
                margin: "0 0 8px",
                lineHeight: 1.5,
              }}
            >
              {llmInfo.hint}
            </p>

            <div style={{ position: "relative" }}>
              <CopyButton text={llm === "claude-code" ? claudeCodeCmd : httpConfig} />
              <pre
                className="mono"
                style={{
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  padding: "14px 70px 14px 14px",
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "var(--text)",
                  overflow: "auto",
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
{llm === "claude-code" ? claudeCodeCmd : httpConfig}
              </pre>
            </div>

            {/* Stdio fallback — nested inside manual config */}
            <details style={{ marginTop: 12 }}>
              <summary
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--text-mute)",
                  cursor: "pointer",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                Stdio fallback (older clients)
              </summary>
              <div style={{ marginTop: 10, position: "relative" }}>
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--text-mute)",
                    margin: "0 0 8px",
                    lineHeight: 1.5,
                  }}
                >
                  For clients without remote-MCP support. Download{" "}
                  <a className="lnk-gold mono" href="/coliseum-mcp.mjs" download>
                    coliseum-mcp.mjs
                  </a>{" "}
                  to <code className="mono">~/.coliseum/</code>, then use this config:
                </p>
                <div style={{ position: "relative" }}>
                  <CopyButton text={stdioConfig} />
                  <pre
                    className="mono"
                    style={{
                      background: "var(--bg-2)",
                      border: "1px solid var(--line)",
                      borderRadius: 4,
                      padding: "14px 70px 14px 14px",
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: "var(--text)",
                      overflow: "auto",
                      margin: 0,
                      whiteSpace: "pre-wrap",
                    }}
                  >
{stdioConfig}
                  </pre>
                </div>
              </div>
            </details>
          </div>
        </details>

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
