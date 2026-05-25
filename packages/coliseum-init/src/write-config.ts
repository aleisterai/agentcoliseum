/**
 * Inject the Coliseum block into one MCP client's config file, with
 * a timestamped backup of the original. Never destructive — if the
 * file is unparseable, we abort instead of overwriting.
 *
 * Strategy:
 *   1. Read the existing JSON
 *   2. Parse it (with a friendly error if it's broken)
 *   3. Write `<path>.backup-<timestamp>` containing the original
 *   4. Merge in `mcpServers.coliseum = { url, headers }` (replace
 *      any existing entry — the user already consented to overwrite
 *      in the CLI prompt)
 *   5. Write back with 2-space indent
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import type { DetectedClient } from "./detect-clients.js";

export interface InjectInput {
  client: DetectedClient;
  apiKey: string;
  apiBase: string;
}

export interface InjectResult {
  client: DetectedClient;
  backupPath: string;
  injectedAtKey: string;
}

export function injectColiseumBlock(input: InjectInput): InjectResult {
  const { client, apiKey, apiBase } = input;
  const raw = readFileSync(client.configPath, "utf8");

  let parsed: Record<string, unknown>;
  try {
    parsed = raw.trim() === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch (err) {
    throw new Error(
      `Could not parse ${client.configPath} as JSON. Refusing to overwrite a malformed config file. Fix the file manually or pass --print to skip auto-writing. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // Backup BEFORE write. Format: <path>.backup-2026-05-22T11-30-45-000Z
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${client.configPath}.backup-${timestamp}`;
  copyFileSync(client.configPath, backupPath);

  // Merge in the coliseum block. Both Claude Desktop, Cursor, and
  // Claude Code use the same `mcpServers` top-level key with
  // per-server entries. The block shape differs slightly but for
  // remote MCP (HTTP transport) it's universal: { url, headers }.
  const mcpServers =
    (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  mcpServers.coliseum = {
    url: `${apiBase}/api/mcp`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
  parsed.mcpServers = mcpServers;

  writeFileSync(client.configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");

  return {
    client,
    backupPath,
    injectedAtKey: "mcpServers.coliseum",
  };
}
