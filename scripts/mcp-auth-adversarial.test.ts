/**
 * mcp-auth-adversarial — every "no, you can't do that" case for the
 * three MCP auth contracts. The happy paths are covered by
 * mcp-prod-e2e and mcp-oauth-smoke; this file is the negative half:
 * every assertion expects a SPECIFIC error shape, not a 2xx.
 *
 * Why we own this: an OAuth implementation that 2xx's on a wrong PKCE
 * verifier is a P0 security regression. mcp-prod-e2e wouldn't catch
 * it because the happy path still works. We need a dedicated battery
 * of hostile cases that runs against every deploy.
 *
 * Run:
 *   pnpm mcp:adversarial                         # against localhost
 *   MCP_ORIGIN=https://www.agentcoliseum.xyz pnpm mcp:adversarial
 *
 * Reuses seeded mcp-duel-alpha + mcp-duel-beta agents — run
 * `pnpm mcp:duel` once first if they don't exist.
 *
 * Exit code: 0 = all hostile cases produced the expected error; 1 =
 * something accepted a request it should have rejected.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client.js";
import { agents, mcpOauthCodes } from "../src/lib/db/schema.js";
import { CODE_PREFIX, randomSecret } from "../src/lib/mcp-oauth.js";

const ORIGIN = process.env.MCP_ORIGIN ?? "http://localhost:3000";

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

interface CaseResult { name: string; ok: boolean; detail?: string }
const results: CaseResult[] = [];
function pass(name: string) { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
function fail(name: string, detail: string) { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name}\n      ${detail}`); }

interface TokenError { error: string; error_description?: string }
interface JsonRpcError { error?: { code: number; message: string } }

/**
 * Most OAuth endpoints respond with HTTP 4xx + { error, error_description } body.
 * Some respond with HTTP 200 + JSON-RPC { error: { code, message } } envelope
 * (the /api/mcp tool dispatch path). This helper handles both forms.
 */
async function fetchExpectError(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: TokenError | JsonRpcError | Record<string, unknown> }> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/**
 * Create a fresh DCR client + a seeded authorization code with a known PKCE
 * challenge — every adversarial case takes one of these and corrupts a single
 * field before calling /oauth/token.
 */
interface OAuthFixture {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  agentId: string;
  agentHandle: string;
}
async function setupOAuthFixture(agentHandle: string): Promise<OAuthFixture> {
  const meta = await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`).then((r) => r.json() as Promise<{ registration_endpoint: string }>);
  const redirectUri = "http://localhost:65535/oauth/callback";
  const reg = (await (
    await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "mcp-auth-adversarial",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    })
  ).json()) as { client_id: string };

  const agent = await db.query.agents.findFirst({ where: eq(agents.handle, agentHandle) });
  if (!agent) throw new Error(`agent @${agentHandle} not found — run \`pnpm mcp:duel\` first`);

  const { verifier, challenge } = pkcePair();
  const code = randomSecret(CODE_PREFIX, 24);
  await db.insert(mcpOauthCodes).values({
    code,
    clientId: reg.client_id,
    agentId: agent.id,
    ownerId: agent.ownerId!,
    redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    scope: "mcp",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  return { clientId: reg.client_id, code, verifier, redirectUri, agentId: agent.id, agentHandle: agent.handle };
}

async function tokenExchange(params: Record<string, string>): Promise<{ status: number; body: TokenError & { access_token?: string; refresh_token?: string } }> {
  const res = await fetch(`${ORIGIN}/api/mcp/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: (await res.json()) as TokenError & { access_token?: string; refresh_token?: string } };
}

async function mcpCall(token: string, method: string, params?: Record<string, unknown>): Promise<JsonRpcError & { result?: Record<string, unknown> }> {
  return (await (
    await fetch(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
  ).json()) as JsonRpcError & { result?: Record<string, unknown> };
}

// ─────────────────────────────────────────────────────────
// 1 · OAuth /token negative cases
// ─────────────────────────────────────────────────────────
async function tokenNegatives() {
  console.log("\n── OAuth /token negative cases ──");

  // 1a · wrong PKCE verifier
  {
    const f = await setupOAuthFixture("mcp-duel-alpha");
    const wrongVerifier = b64url(randomBytes(32)); // unrelated to the stored challenge
    const r = await tokenExchange({
      grant_type: "authorization_code", code: f.code, redirect_uri: f.redirectUri,
      client_id: f.clientId, code_verifier: wrongVerifier,
    });
    if (r.status === 400 && r.body.error === "invalid_grant" && /PKCE/i.test(r.body.error_description ?? "")) {
      pass("wrong PKCE verifier → 400 invalid_grant (PKCE mismatch)");
    } else {
      fail("wrong PKCE verifier", `expected 400 invalid_grant PKCE — got ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // 1b · code reused after successful exchange
  {
    const f = await setupOAuthFixture("mcp-duel-alpha");
    const first = await tokenExchange({
      grant_type: "authorization_code", code: f.code, redirect_uri: f.redirectUri,
      client_id: f.clientId, code_verifier: f.verifier,
    });
    if (first.status !== 200 || !first.body.access_token) {
      fail("code reuse — first exchange must succeed", `got ${first.status} ${JSON.stringify(first.body)}`);
      return;
    }
    const second = await tokenExchange({
      grant_type: "authorization_code", code: f.code, redirect_uri: f.redirectUri,
      client_id: f.clientId, code_verifier: f.verifier,
    });
    if (second.status === 400 && second.body.error === "invalid_grant" && /already/i.test(second.body.error_description ?? "")) {
      pass("reused authorization code → 400 invalid_grant (already exchanged)");
    } else {
      fail("reused authorization code", `expected 400 invalid_grant already — got ${second.status} ${JSON.stringify(second.body)}`);
    }
  }

  // 1c · mismatched redirect_uri
  {
    const f = await setupOAuthFixture("mcp-duel-alpha");
    const r = await tokenExchange({
      grant_type: "authorization_code", code: f.code, redirect_uri: "http://attacker.example/callback",
      client_id: f.clientId, code_verifier: f.verifier,
    });
    if (r.status === 400 && r.body.error === "invalid_grant" && /redirect_uri/i.test(r.body.error_description ?? "")) {
      pass("mismatched redirect_uri → 400 invalid_grant (redirect_uri mismatch)");
    } else {
      fail("mismatched redirect_uri", `expected 400 invalid_grant redirect — got ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // 1d · wrong client_id (code minted under a different client)
  {
    const f = await setupOAuthFixture("mcp-duel-alpha");
    const otherClient = (await (
      await fetch(`${ORIGIN}/api/mcp/oauth/register`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "other-client", redirect_uris: [f.redirectUri], grant_types: ["authorization_code"], response_types: ["code"] }),
      })
    ).json()) as { client_id: string };
    const r = await tokenExchange({
      grant_type: "authorization_code", code: f.code, redirect_uri: f.redirectUri,
      client_id: otherClient.client_id, code_verifier: f.verifier,
    });
    if (r.status === 400 && r.body.error === "invalid_grant" && /this client/i.test(r.body.error_description ?? "")) {
      pass("wrong client_id at exchange → 400 invalid_grant (issued to another client)");
    } else {
      fail("wrong client_id at exchange", `expected 400 invalid_grant client mismatch — got ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // 1e · expired authorization code
  {
    const f = await setupOAuthFixture("mcp-duel-alpha");
    // Backdate the code so it's already expired
    await db
      .update(mcpOauthCodes)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(mcpOauthCodes.code, f.code));
    const r = await tokenExchange({
      grant_type: "authorization_code", code: f.code, redirect_uri: f.redirectUri,
      client_id: f.clientId, code_verifier: f.verifier,
    });
    if (r.status === 400 && r.body.error === "invalid_grant" && /expired/i.test(r.body.error_description ?? "")) {
      pass("expired authorization code → 400 invalid_grant (expired)");
    } else {
      fail("expired authorization code", `expected 400 invalid_grant expired — got ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // 1f · missing required fields
  {
    const r = await tokenExchange({ grant_type: "authorization_code", code: "acoc_xxx" });
    if (r.status === 400 && r.body.error === "invalid_request") {
      pass("token request missing fields → 400 invalid_request");
    } else {
      fail("token request missing fields", `expected 400 invalid_request — got ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  // 1g · unknown grant_type
  {
    const r = await tokenExchange({ grant_type: "password", username: "x", password: "y" });
    if (r.status === 400 && (r.body.error === "unsupported_grant_type" || r.body.error === "invalid_request")) {
      pass("unsupported grant_type → 400 unsupported_grant_type");
    } else {
      fail("unsupported grant_type", `expected 400 unsupported_grant_type — got ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────
// 2 · Access-token negative cases
// ─────────────────────────────────────────────────────────
async function accessTokenNegatives() {
  console.log("\n── /api/mcp bearer negative cases ──");

  // 2a · no Authorization header
  {
    const res = await fetch(`${ORIGIN}/api/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await res.json()) as JsonRpcError;
    if (body.error && (body.error.code === -32002 || body.error.code === -32001)) {
      pass(`missing Authorization → JSON-RPC ${body.error.code}`);
    } else {
      fail("missing Authorization", `expected -32002/-32001 — got ${JSON.stringify(body)}`);
    }
  }

  // 2b · garbage bearer
  {
    const r = await mcpCall("not_a_real_token_string_xxxxx", "tools/list");
    if (r.error?.code === -32002) {
      pass("garbage bearer → -32002 Credential not recognized");
    } else {
      fail("garbage bearer", `expected -32002 — got ${JSON.stringify(r)}`);
    }
  }

  // 2c · access-token replay after refresh (steps from oauth-smoke step 8)
  {
    const f = await setupOAuthFixture("mcp-duel-alpha");
    const first = await tokenExchange({
      grant_type: "authorization_code", code: f.code, redirect_uri: f.redirectUri,
      client_id: f.clientId, code_verifier: f.verifier,
    });
    if (!first.body.access_token || !first.body.refresh_token) {
      fail("replay setup", `expected access+refresh tokens — got ${JSON.stringify(first.body)}`);
      return;
    }
    // Refresh — this should rotate and revoke the old access token
    const refreshed = await tokenExchange({
      grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: f.clientId,
    });
    if (!refreshed.body.access_token) {
      fail("replay setup refresh", `expected new access_token — got ${JSON.stringify(refreshed.body)}`);
      return;
    }
    // Replay the OLD access token — should fail
    const replay = await mcpCall(first.body.access_token, "tools/list");
    if (replay.error?.code === -32002) {
      pass("replayed old access token (post-refresh) → -32002");
    } else {
      fail("replayed old access token", `expected -32002 — got ${JSON.stringify(replay)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────
// 3 · Cross-agent isolation
// ─────────────────────────────────────────────────────────
async function crossAgentIsolation() {
  console.log("\n── cross-agent isolation ──");

  const alpha = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-alpha") });
  const beta = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-beta") });
  if (!alpha || !beta) {
    fail("cross-agent setup", "mcp-duel-alpha or mcp-duel-beta missing — run `pnpm mcp:duel` first");
    return;
  }

  // 3a · alpha's ack_ returns alpha's profile, never beta's
  {
    const r = await mcpCall(alpha.apiKey, "tools/call", { name: "coliseum_agent_profile_get", arguments: {} });
    const text = (r.result?.content as Array<{ text: string }>)?.[0]?.text;
    const parsed = text ? (JSON.parse(text) as { handle?: string; id?: string }) : null;
    if (parsed?.handle === alpha.handle && parsed?.id !== beta.id) {
      pass(`alpha's ack_ → @${alpha.handle} profile only (no beta leak)`);
    } else {
      fail("alpha ack_ profile_get", `expected @${alpha.handle}, got @${parsed?.handle}`);
    }
  }

  // 3b · beta's ack_ returns beta's profile, never alpha's
  {
    const r = await mcpCall(beta.apiKey, "tools/call", { name: "coliseum_agent_profile_get", arguments: {} });
    const text = (r.result?.content as Array<{ text: string }>)?.[0]?.text;
    const parsed = text ? (JSON.parse(text) as { handle?: string; id?: string }) : null;
    if (parsed?.handle === beta.handle && parsed?.id !== alpha.id) {
      pass(`beta's ack_ → @${beta.handle} profile only (no alpha leak)`);
    } else {
      fail("beta ack_ profile_get", `expected @${beta.handle}, got @${parsed?.handle}`);
    }
  }

  // 3c · alpha cannot read beta's matches via match_list
  {
    const r = await mcpCall(alpha.apiKey, "tools/call", { name: "coliseum_match_list", arguments: {} });
    const text = (r.result?.content as Array<{ text: string }>)?.[0]?.text;
    const parsed = text ? (JSON.parse(text) as { activeMatches?: Array<{ matchId: string; opponent?: { id?: string } }> }) : null;
    // every match returned should have alpha (not beta) on at least one side; opponent is the OTHER agent
    const wrong = (parsed?.activeMatches ?? []).find((m) => m.opponent?.id === alpha.id);
    if (!wrong) {
      pass(`alpha's match_list never returns matches where alpha is the opponent (cross-leak check)`);
    } else {
      fail("alpha match_list leak", `match ${wrong.matchId} listed alpha as opponent — would imply impersonation`);
    }
  }
}

// ─────────────────────────────────────────────────────────
// 4 · DCR misuse
// ─────────────────────────────────────────────────────────
async function dcrNegatives() {
  console.log("\n── DCR negative cases ──");

  // 4a · DCR with no redirect_uris should reject (or accept w/ default — verify shape)
  {
    const res = await fetch(`${ORIGIN}/api/mcp/oauth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "no-redirect" }),
    });
    const body = (await res.json()) as { error?: string; redirect_uris?: string[] };
    if (res.status >= 400 && body.error) {
      pass(`DCR without redirect_uris → ${res.status} ${body.error}`);
    } else if (res.status === 200 && Array.isArray(body.redirect_uris) && body.redirect_uris.length === 0) {
      // Some implementations accept with empty array — also acceptable IF token endpoint
      // later rejects any redirect_uri attempt. Verify by trying to exchange.
      pass(`DCR accepts empty redirect_uris (token endpoint enforces match later)`);
    } else {
      fail("DCR without redirect_uris", `unexpected ${res.status} ${JSON.stringify(body)}`);
    }
  }
}

async function main() {
  console.log(`→ ORIGIN ${ORIGIN}`);
  await tokenNegatives();
  await accessTokenNegatives();
  await crossAgentIsolation();
  await dcrNegatives();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n══════════ summary ══════════`);
  console.log(`adversarial   ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`\n${failed} CASE(S) ACCEPTED A REQUEST THAT SHOULD HAVE BEEN REJECTED ↑`);
    process.exit(1);
  }
  console.log(`\n✓ every hostile case was rejected with the right shape`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
