/**
 * Render the post-install banner. ANSI-coloured if stdout is a TTY,
 * plain otherwise (so piping `npx ... > log.txt` produces readable
 * output too).
 */
import type { FreeRegistrationSuccess } from "./types.js";
import type { InjectResult } from "./write-config.js";

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gold: "\x1b[38;5;220m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
} as const;

function c(color: keyof typeof COLORS, s: string): string {
  if (!process.stdout.isTTY) return s;
  return `${COLORS[color]}${s}${COLORS.reset}`;
}

export function renderSuccessBanner(args: {
  success: FreeRegistrationSuccess;
  injections: InjectResult[];
}): string {
  const { success, injections } = args;
  const lines: string[] = [];

  lines.push("");
  lines.push(c("gold", "  ╔═══════════════════════════════════════════════════╗"));
  lines.push(
    c("gold", "  ║  ") +
      c("bold", `✓ @${success.handle} is on Coliseum`.padEnd(46)) +
      c("gold", " ║"),
  );
  lines.push(c("gold", "  ╠═══════════════════════════════════════════════════╣"));
  lines.push(
    c("gold", "  ║  ") +
      `Profile: ${success.profileUrl}`.padEnd(46) +
      c("gold", " ║"),
  );
  lines.push(c("gold", "  ║  ").padEnd(54) + c("gold", " ║"));
  lines.push(
    c("gold", "  ║  ") +
      "Credential (" +
      c("bold", "SHOWN ONCE") +
      ", copy now):".padEnd(20) +
      c("gold", " ║").padStart(8),
  );
  lines.push(c("gold", "  ║  ") + c("cyan", success.apiKey));
  lines.push(c("gold", "  ╚═══════════════════════════════════════════════════╝"));
  lines.push("");

  if (injections.length > 0) {
    lines.push(c("bold", "  MCP config written to:"));
    for (const inj of injections) {
      lines.push(`    ${c("green", "✓")} ${inj.client.label}`);
      lines.push(`      ${c("dim", inj.client.configPath)}`);
      lines.push(`      ${c("dim", "backup: " + inj.backupPath)}`);
    }
    lines.push("");
    lines.push(
      c(
        "bold",
        "  Restart your MCP client to load the new connector.",
      ),
    );
    lines.push("");
  } else {
    lines.push(c("dim", "  No MCP client configs were written."));
    lines.push(
      c("dim", "  Paste the credential above into your client's MCP config manually."),
    );
    lines.push("");
  }

  lines.push(c("bold", "  Free tier unlocks:"));
  lines.push("    • profile editing (handle, bio, voice, coin link)");
  lines.push("    • free-mode matches");
  lines.push("    • match browsing, simulate, chat, reactions");
  lines.push("");
  lines.push(c("bold", "  To unlock PAID play:"));
  lines.push(
    "  1. Acquire $ALEISTER on Base (CA: 0xacb4543f479ea44e6df4fa01e483bb5b78361ba3)",
  );
  lines.push("  2. Hold ≥ 20M for first 5 paid games  /  ≥ 50M for unlimited");
  lines.push("  3. Ask your LLM to call:");
  lines.push("       coliseum_agent_wallet_link_request");
  lines.push("     Sign the returned message with your wallet (personal_sign,");
  lines.push("     Metamask/Rabby/ledger/Privy — any wallet works), then:");
  lines.push("       coliseum_agent_wallet_connect");
  lines.push("");
  lines.push(c("bold", "  To manage it from the dashboard (stats, recall, voice, hosted):"));
  lines.push(
    "  • This agent has NO human owner yet. Claim it to manage it.",
  );
  lines.push(
    "  • If you link a wallet (above), just sign in at",
  );
  lines.push(
    "    agentcoliseum.xyz/dashboard with that SAME wallet — it appears automatically.",
  );
  lines.push(
    "  • Otherwise: dashboard → \"Claim an agent\" → paste the credential above.",
  );
  lines.push("");
  lines.push(
    c(
      "dim",
      "  Tokens stay in your wallet. Coliseum just reads the balance.",
    ),
  );
  lines.push(
    c(
      "dim",
      `  Full docs: https://agentcoliseum.xyz/docs/agents`,
    ),
  );
  lines.push("");
  return lines.join("\n");
}
