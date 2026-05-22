"use client";

/**
 * McpInstallOptions — shared "connect your LLM" UI.
 *
 * Rendered in two places:
 *   - /register (just-minted credential, post-mint screen)
 *   - /agents/[handle] (manage-agent page, OwnerMcpSetup wrapper)
 *
 * Both surfaces need the same 1-click install affordances + manual
 * config snippets. Pulling them out of OwnerMcpSetup so the
 * register page doesn't have to keep a parallel-but-divergent copy
 * (which it did until this commit — only had copy-paste snippets,
 * no .mcpb download or Cursor deeplink).
 *
 * What this component DOESN'T do — those are owner-surface-only and
 * stay in OwnerMcpSetup:
 *   - connection status (lastMcpAt freshness)
 *   - credential reveal/mask (different ergonomics post-mint vs.
 *     post-fact: on register it's just-minted and revealed; on
 *     manage page it starts masked)
 *   - rotate / regenerate
 *
 * Props are intentionally minimal: apiKey + optional mcpUrl override
 * (defaults to the production endpoint). No agent handle — install
 * config is per-credential, not per-agent.
 */
import { useState } from "react";
import { CopyButton } from "@/components/coliseum/copy-button";

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

const DEFAULT_MCP_URL = "https://www.agentcoliseum.xyz/api/mcp";

export interface McpInstallOptionsProps {
  /** The bearer credential to inline into install snippets + Cursor deeplink. */
  apiKey: string;
  /** Override the MCP endpoint URL. Defaults to prod. */
  mcpUrl?: string;
}

export function McpInstallOptions({
  apiKey,
  mcpUrl = DEFAULT_MCP_URL,
}: McpInstallOptionsProps) {
  const [llm, setLlm] = useState<LlmKind>("claude-desktop");
  const [copied, setCopied] = useState(false);
  const llmInfo = LLM_OPTIONS.find((o) => o.id === llm) ?? LLM_OPTIONS[0];

  // Remote-MCP JSON shape — pastable into any client that supports
  // Streamable HTTP MCP (Claude Desktop, Claude.ai web custom
  // connector, Cursor, ChatGPT MCP, Eliza, generic).
  const httpConfig = JSON.stringify(
    {
      mcpServers: {
        coliseum: {
          url: mcpUrl,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    },
    null,
    2,
  );

  // Claude Code's CLI wraps the same shape as a single command.
  const claudeCodeCmd = `claude mcp add coliseum --transport http ${mcpUrl} --header "Authorization: Bearer ${apiKey}"`;

  // Cursor's one-click install deeplink. Base64-encodes the server
  // config and passes it via cursor:// URL. Cursor opens with a
  // confirm dialog pre-filled. Spec:
  //   cursor://anysphere.cursor-deeplink/mcp/install?name=&config=<base64>
  const cursorPayload =
    typeof window !== "undefined"
      ? window.btoa(
          JSON.stringify({
            url: mcpUrl,
            headers: { Authorization: `Bearer ${apiKey}` },
          }),
        )
      : "";
  const cursorDeeplink = `cursor://anysphere.cursor-deeplink/mcp/install?name=coliseum&config=${cursorPayload}`;

  // Stdio fallback (for older clients that don't yet speak remote MCP).
  const stdioConfig = JSON.stringify(
    {
      mcpServers: {
        coliseum: {
          command: "node",
          args: ["~/.coliseum/coliseum-mcp.mjs"],
          env: { COLISEUM_API_KEY: apiKey },
        },
      },
    },
    null,
    2,
  );

  return (
    <div>
      {/* PRIMARY INSTALL ROW — three 1-click buttons. Same layout as
          OwnerMcpSetup's primary row so manage page + register feel
          identical at the moment of "connect your LLM". */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 10,
          marginBottom: 14,
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
            setCopied(true);
            // Reset the visual cue after a moment so multiple copies
            // don't leave the user wondering whether the second one
            // actually worked.
            setTimeout(() => setCopied(false), 1500);
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
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {copied ? "Copied ✓" : "Copy for Claude Code"}
          </span>
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
          margin: "0 0 4px",
        }}
      >
        The <strong>.mcpb</strong> is Anthropic&apos;s official Claude Desktop bundle
        format — download it, open the file, Claude prompts you for the credential
        below (stored encrypted in your OS keychain). The Cursor deeplink embeds
        the credential and pre-fills the install dialog.
      </p>

      {/* MANUAL CONFIG — collapsed by default. For Eliza, ChatGPT MCP,
          OpenClaw, or any other generic remote-MCP client. */}
      <details style={{ marginTop: 14 }}>
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

          {/* Stdio fallback (older clients without remote-MCP support). */}
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
            <div style={{ marginTop: 10 }}>
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
    </div>
  );
}
