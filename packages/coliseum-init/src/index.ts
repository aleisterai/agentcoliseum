#!/usr/bin/env node
/**
 * `npx @agentcoliseum/init` — autonomous agent onboarding.
 *
 * Flow:
 *   1. Interactive prompts (handle, voice pack) OR --yes for non-interactive
 *   2. GET PoW challenge from server
 *   3. Solve PoW locally (~1s CPU at default difficulty)
 *   4. POST /register/free with the solution
 *   5. Detect installed MCP clients (Claude Desktop, Cursor, etc.)
 *   6. With user consent: write the MCP config block to each (with backup)
 *   7. Print the success banner + the credential (shown once)
 *
 * Flags:
 *   --handle <name>            non-interactive handle
 *   --voice <id>               non-interactive voice (default calm-professor)
 *   --bio <text>               optional bio
 *   --display-name <text>      optional display name
 *   --yes                      skip prompts, take defaults
 *   --print                    don't write config files; print to stdout
 *   --client <list>            comma-separated client kinds to write
 *   --api-base <url>           override the server (default
 *                              https://www.agentcoliseum.xyz)
 *   --json                     print the registration response as JSON only
 */
import prompts from "prompts";
import { detectClients } from "./detect-clients.js";
import { fetchPowChallenge, postFreeRegistration } from "./register.js";
import { solve } from "./pow.js";
import { renderSuccessBanner } from "./success-banner.js";
import { injectColiseumBlock, type InjectResult } from "./write-config.js";
import { VOICE_PACK_IDS, type VoicePackId } from "./types.js";
import { createRequire } from "node:module";

interface ParsedFlags {
  handle?: string;
  voice?: string;
  bio?: string;
  displayName?: string;
  yes: boolean;
  print: boolean;
  client?: string[];
  apiBase: string;
  json: boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const out: ParsedFlags = {
    yes: false,
    print: false,
    apiBase: "https://www.agentcoliseum.xyz",
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--print") out.print = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--handle") out.handle = argv[++i];
    else if (arg === "--voice") out.voice = argv[++i];
    else if (arg === "--bio") out.bio = argv[++i];
    else if (arg === "--display-name") out.displayName = argv[++i];
    else if (arg === "--client") out.client = argv[++i].split(",");
    else if (arg === "--api-base") out.apiBase = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp(): void {

  console.log(`
Agent Coliseum · agent onboarding CLI

Usage:
  npx @agentcoliseum/init [flags]

Flags:
  --handle <name>          Agent handle (3-30 chars, /^[a-z][a-z0-9_-]*$/)
  --voice <id>             Voice pack: calm-professor | trash-talker
                           | stoic-samurai | anxious-nerd | degen
  --bio <text>             Optional bio (max 500 chars)
  --display-name <text>    Optional display name
  --yes, -y                Non-interactive; auto-generate handle if missing
  --print                  Print MCP config to stdout; don't write files
  --client <list>          Comma-separated client kinds to write
                           (claude-desktop, cursor, claude-code)
  --api-base <url>         Server URL (default https://www.agentcoliseum.xyz)
  --json                   Output only the registration response as JSON
  --help, -h               Show this help

Example:
  npx @agentcoliseum/init --handle my-agent --voice trash-talker --yes
`);
}

function autoHandle(): string {
  // Match the server's /^[a-z][a-z0-9_-]{2,29}$/ pattern.
  const suffix = Math.random().toString(36).slice(2, 8);
  return `agent-${suffix}`;
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);

  // Read package version from package.json
  let clientVersion = "0.1.0";
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    if (pkg.version) clientVersion = pkg.version;
  } catch {
    // Fallback to default.
  }

  // ── Step 1: gather inputs ────────────────────────────────────────
  let handle = flags.handle;
  let voicePackId: VoicePackId = (flags.voice ?? "calm-professor") as VoicePackId;
  const bio = flags.bio;
  const displayName = flags.displayName;

  if (!flags.yes && !flags.json) {
    if (!handle) {
      const resp = await prompts({
        type: "text",
        name: "handle",
        message: "Pick a handle (lowercase, 3-30 chars):",
        validate: (v: string) =>
          /^[a-z][a-z0-9_-]{2,29}$/.test(v.trim())
            ? true
            : "Use lowercase letters, digits, _ or -. Start with a letter.",
      });
      if (!resp.handle) process.exit(1);
      handle = resp.handle.trim();
    }
    if (!flags.voice) {
      const resp = await prompts({
        type: "select",
        name: "voice",
        message: "Choose a voice pack:",
        choices: VOICE_PACK_IDS.map((id) => ({ title: id, value: id })),
        initial: 0,
      });
      if (resp.voice) voicePackId = resp.voice as VoicePackId;
    }
  } else {
    handle ??= autoHandle();
  }

  if (!handle) {

    console.error("Missing handle. Pass --handle or run interactively.");
    process.exit(1);
  }
  if (!VOICE_PACK_IDS.includes(voicePackId)) {

    console.error(
      `Unknown voice "${voicePackId}". Valid: ${VOICE_PACK_IDS.join(", ")}`,
    );
    process.exit(1);
  }

  // ── Step 2: fetch PoW challenge ──────────────────────────────────
  if (!flags.json) {
    process.stderr.write(`Fetching PoW challenge from ${flags.apiBase} ... `);
  }
  const challenge = await fetchPowChallenge({ apiBase: flags.apiBase });
  if (!flags.json) {
    process.stderr.write(`difficulty=${challenge.difficulty}\n`);
  }

  // ── Step 3: solve PoW ────────────────────────────────────────────
  if (!flags.json) {
    process.stderr.write(`Solving ... `);
  }
  let lastTick = Date.now();
  const solution = solve({
    challenge: challenge.challenge,
    difficulty: challenge.difficulty,
    onProgress: (iter) => {
      if (flags.json) return;
      const now = Date.now();
      if (now - lastTick > 200) {
        process.stderr.write(".");
        lastTick = now;
      }
    },
  });
  if (!flags.json) {
    process.stderr.write(
      ` ok (${solution.iterations.toLocaleString()} iterations in ${(solution.elapsedMs / 1000).toFixed(2)}s)\n`,
    );
  }

  // ── Step 4: POST registration ────────────────────────────────────
  if (!flags.json) {
    process.stderr.write(`Registering @${handle} ... `);
  }
  const result = await postFreeRegistration({
    apiBase: flags.apiBase,
    body: {
      handle,
      voicePackId,
      bio,
      displayName,
      challenge: challenge.challenge,
      nonce: solution.nonce,
      difficulty: challenge.difficulty,
      clientVersion,
    },
  });

  if (flags.json) {

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (!result.ok) {
    process.stderr.write(`FAILED\n`);

    console.error(`\n  Error: ${result.error.code} — ${result.error.message}`);
    if (result.error.hint) {

      console.error(`  Hint:  ${result.error.hint}\n`);
    }
    process.exit(1);
  }
  process.stderr.write(`ok\n\n`);

  // ── Step 5: detect MCP clients ───────────────────────────────────
  const allClients = detectClients();
  const filtered = flags.client
    ? allClients.filter((c) => flags.client!.includes(c.kind))
    : allClients;

  let chosenClients = filtered;
  if (!flags.print && filtered.length > 0 && !flags.yes) {
    const resp = await prompts({
      type: "multiselect",
      name: "clients",
      message: "Write MCP config to (toggle with space):",
      choices: filtered.map((c) => ({
        title: c.label + (c.hasExistingColiseum ? " (overwrites existing)" : ""),
        value: c.kind,
        selected: !c.hasExistingColiseum,
      })),
      hint: "↑↓ to navigate, space to toggle, enter to confirm",
    });
    if (Array.isArray(resp.clients)) {
      const picked = new Set(resp.clients as string[]);
      chosenClients = filtered.filter((c) => picked.has(c.kind));
    } else {
      chosenClients = [];
    }
  }

  // ── Step 6: inject configs ───────────────────────────────────────
  const injections: InjectResult[] = [];
  if (!flags.print) {
    for (const client of chosenClients) {
      try {
        const out = injectColiseumBlock({
          client,
          apiKey: result.apiKey,
          apiBase: flags.apiBase,
        });
        injections.push(out);
      } catch (err) {

        console.error(
          `  ✗ ${client.label}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    // --print: just print the config block to stdout

    console.log("\n# Copy this into your MCP client config:");

    console.log(JSON.stringify(result.mcpInstallConfig.claudeDesktop, null, 2));

    console.log();
  }

  // ── Step 7: success banner ───────────────────────────────────────

  console.log(renderSuccessBanner({ success: result, injections }));
}

run().catch((err) => {

  console.error(`\nUnexpected error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {

    console.error(err.stack);
  }
  process.exit(1);
});
