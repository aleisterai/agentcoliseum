/**
 * Detect installed MCP clients on the user's machine + plan where to
 * inject the Coliseum block. Cross-platform: macOS, Windows, Linux.
 *
 * Strategy: probe the canonical config-file paths each client uses.
 * If the file exists, the client is "installed enough" to receive
 * the inject. If multiple candidates exist for a client (e.g. Cursor
 * has both User and Workspace configs), prefer User.
 *
 * We DON'T touch a client unless the user opts in — the CLI presents
 * the detected list and the user picks.
 */
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type ClientKind =
  | "claude-desktop"
  | "cursor"
  | "claude-code"
  | "chatgpt-mcp";

export interface DetectedClient {
  kind: ClientKind;
  label: string;
  configPath: string;
  /** True if the config file already has a "coliseum" entry. */
  hasExistingColiseum: boolean;
}

/** Probe known config paths for the current platform; return clients
 *  whose config file exists. */
export function detectClients(): DetectedClient[] {
  const home = homedir();
  const candidates: Array<{
    kind: ClientKind;
    label: string;
    path: string;
  }> = [];

  if (platform() === "darwin") {
    candidates.push({
      kind: "claude-desktop",
      label: "Claude Desktop (macOS)",
      path: join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      ),
    });
    candidates.push({
      kind: "cursor",
      label: "Cursor (macOS)",
      path: join(home, ".cursor", "mcp.json"),
    });
  } else if (platform() === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push({
        kind: "claude-desktop",
        label: "Claude Desktop (Windows)",
        path: join(appData, "Claude", "claude_desktop_config.json"),
      });
      candidates.push({
        kind: "cursor",
        label: "Cursor (Windows)",
        path: join(appData, "Cursor", "User", "globalStorage", "mcp.json"),
      });
    }
  } else {
    // Linux + others
    candidates.push({
      kind: "claude-desktop",
      label: "Claude Desktop (Linux)",
      path: join(home, ".config", "Claude", "claude_desktop_config.json"),
    });
    candidates.push({
      kind: "cursor",
      label: "Cursor (Linux)",
      path: join(home, ".config", "Cursor", "User", "globalStorage", "mcp.json"),
    });
  }

  // Claude Code (CLI) config is cross-platform under XDG/.config
  candidates.push({
    kind: "claude-code",
    label: "Claude Code (CLI)",
    path: join(home, ".claude", "mcp_servers.json"),
  });

  return candidates
    .filter((c) => existsSync(c.path))
    .map((c) => ({
      kind: c.kind,
      label: c.label,
      configPath: c.path,
      hasExistingColiseum: detectExistingColiseum(c.path),
    }));
}

function detectExistingColiseum(path: string): boolean {
  try {
    // Read the file as text and look for the "coliseum" key. We don't
    // parse JSON here because some config files have comments (Cursor
    // tolerates JSON-with-comments) and a parse error shouldn't lie
    // about "no existing coliseum" — be conservative and assume YES
    // if the file is unreadable.
    const fs = require("node:fs") as typeof import("node:fs");
    const text = fs.readFileSync(path, "utf8");
    return /"coliseum"\s*:/.test(text);
  } catch {
    return false;
  }
}
