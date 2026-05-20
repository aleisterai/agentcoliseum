/**
 * mcp-oauth-smoke — drive the OAuth dance end-to-end against the live
 * /api/mcp endpoint. Proves that:
 *
 *   1. /.well-known/oauth-authorization-server returns metadata
 *   2. DCR (/api/mcp/oauth/register) mints a client_id
 *   3. Direct DB insert of an authorization code (skipping the
 *      Privy-gated /oauth/authorize page — that needs a real browser
 *      session) plus the code+verifier exchange at /oauth/token
 *      issues an acoth_… access token bound to the chosen agent
 *   4. The acoth_… token authenticates against /api/mcp tools/list
 *
 * This is the wire-level proof. The browser side (Claude.ai → consent
 * screen) is necessarily a manual test because it requires a real
 * Privy session.
 *
 * Reuses the mcp-duel test agents (mcp-duel-alpha / mcp-duel-beta) so
 * we don't pollute the DB with one-shot rows. If those rows don't
 * exist, run `pnpm mcp:duel` once first.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client.js";
import { agents, mcpOauthCodes } from "../src/lib/db/schema.js";
import { CODE_PREFIX, randomSecret } from "../src/lib/mcp-oauth.js";

const ORIGIN = process.env.MCP_ORIGIN ?? "http://localhost:3000";
const AGENT_HANDLE = process.env.SMOKE_AGENT_HANDLE ?? "mcp-duel-alpha";

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function generateVerifier(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json()) as T & { error?: string; error_description?: string };
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${url} → ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function main() {
  console.log(`→ origin: ${ORIGIN}\n`);

  console.log("1. fetch /.well-known/oauth-authorization-server");
  const meta = await fetchJson<{
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    code_challenge_methods_supported: string[];
  }>(`${ORIGIN}/.well-known/oauth-authorization-server`);
  console.log(`   issuer: ${meta.issuer}`);
  console.log(`   token_endpoint: ${meta.token_endpoint}`);
  console.log(`   pkce methods: ${meta.code_challenge_methods_supported.join(", ")}\n`);
  if (!meta.code_challenge_methods_supported.includes("S256")) {
    throw new Error("server does not advertise S256 PKCE — refusing to continue");
  }

  console.log("2. DCR — POST /api/mcp/oauth/register");
  const REDIRECT_URI = "http://localhost:65535/oauth/callback";
  const reg = await fetchJson<{ client_id: string; redirect_uris: string[] }>(
    meta.registration_endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "mcp-oauth-smoke",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    },
  );
  console.log(`   client_id: ${reg.client_id}\n`);

  console.log("3. (manual-step bypass) insert an authorization code directly");
  // The real flow puts a user in front of /oauth/authorize so they can
  // pick the agent the client gets to act as. From a CLI we can't open
  // a browser, so we seed the code row directly with the same PKCE
  // challenge a real client would generate.
  const agentRow = await db.query.agents.findFirst({
    where: eq(agents.handle, AGENT_HANDLE),
  });
  if (!agentRow) {
    throw new Error(
      `agent @${AGENT_HANDLE} not found — run \`pnpm mcp:duel\` once first to seed it`,
    );
  }
  const { verifier, challenge } = generateVerifier();
  const code = randomSecret(CODE_PREFIX, 24);
  await db.insert(mcpOauthCodes).values({
    code,
    clientId: reg.client_id,
    agentId: agentRow.id,
    ownerId: agentRow.ownerId,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    scope: "mcp",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  console.log(`   code: ${code.slice(0, 16)}…  bound to agent ${agentRow.id.slice(0, 8)} (@${agentRow.handle})\n`);

  console.log("4. POST /api/mcp/oauth/token (grant_type=authorization_code)");
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: reg.client_id,
    code_verifier: verifier,
  });
  const token = await fetchJson<{
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token: string;
  }>(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  console.log(`   access_token: ${token.access_token.slice(0, 16)}…  type=${token.token_type}  ttl=${token.expires_in}s`);
  console.log(`   refresh_token: ${token.refresh_token.slice(0, 16)}…\n`);

  console.log("5. call /api/mcp tools/list using the new acoth_ token");
  const listed = await fetchJson<{ result?: { tools: Array<{ name: string }> } }>(
    `${ORIGIN}/api/mcp`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
  );
  const toolNames = listed.result?.tools.map((t) => t.name) ?? [];
  console.log(`   tools/list ok — ${toolNames.length} tools returned`);
  console.log(`   sample: ${toolNames.slice(0, 4).join(", ")}…\n`);

  console.log("6. verify the same token can call coliseum_agent_profile_get");
  const profile = await fetchJson<{
    result?: { content: Array<{ type: string; text: string }> };
  }>(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "coliseum_agent_profile_get", arguments: {} },
    }),
  });
  const text = profile.result?.content?.[0]?.text;
  const parsed = text ? (JSON.parse(text) as { handle?: string }) : null;
  console.log(`   profile_get → @${parsed?.handle ?? "?"}\n`);

  console.log("7. refresh — POST /api/mcp/oauth/token (grant_type=refresh_token)");
  const refreshBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: reg.client_id,
  });
  const refreshed = await fetchJson<{ access_token: string; refresh_token: string }>(
    meta.token_endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshBody.toString(),
    },
  );
  console.log(`   new access_token: ${refreshed.access_token.slice(0, 16)}…  (rotated)\n`);

  console.log("8. confirm the OLD acoth_ token is now revoked (should 401 with -32002)");
  const revoked = (await (
    await fetch(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    })
  ).json()) as { error?: { code: number; message: string } };
  if (revoked.error?.code !== -32002) {
    throw new Error(`expected -32002 Credential not recognized, got ${JSON.stringify(revoked)}`);
  }
  console.log(`   old token → ${revoked.error.code} ${revoked.error.message}\n`);

  console.log("✅ OAuth smoke complete — all stages passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nmcp-oauth-smoke failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
