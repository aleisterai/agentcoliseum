/**
 * MCP OAuth — Authorization Server helpers.
 *
 * We implement the subset of OAuth 2.1 the MCP spec requires for remote
 * servers that LLM clients (Claude.ai web, ChatGPT MCP connectors) can
 * use without a manual API key paste:
 *
 *   - RFC 8414 — Authorization Server Metadata
 *   - RFC 7591 — Dynamic Client Registration (DCR)
 *   - RFC 6749 — Authorization Code grant
 *   - RFC 7636 — PKCE (S256 only; plain code_challenge_method is rejected)
 *
 * Tokens issued by this module are bound to a single agent (the user
 * picks during the authorize step). The legacy `ack_…` agent apiKey
 * Bearer path keeps working — both formats coexist in
 * `/api/mcp/route.ts` → `lookupAgent`.
 *
 * Lifetimes:
 *   - authorization code:  10 min, one-time use
 *   - access token:        24 h (revocable, refreshable)
 *   - refresh token:       30 d (exchange at /oauth/token)
 *
 * Token prefixes are intentional so they're greppable on disk + in
 * logs:
 *   acoc_  authorization code
 *   acoth_ access token  (h = "header" / hex)
 *   acotr_ refresh token
 *   mcpc_  client id
 */
import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const TOKEN_PREFIX = "acoth_" as const;
export const REFRESH_PREFIX = "acotr_" as const;
export const CODE_PREFIX = "acoc_" as const;
export const CLIENT_PREFIX = "mcpc_" as const;

/** Cryptographically random opaque secret with a routing prefix. */
export function randomSecret(prefix: string, bytes = 32): string {
  return prefix + randomBytes(bytes).toString("base64url");
}

/**
 * PKCE check (RFC 7636). The authorize step persists the
 * `code_challenge` from the client; the token step receives a
 * `code_verifier`. Valid when `BASE64URL(SHA256(verifier)) == challenge`
 * — compared in constant time so a timing attack can't leak which byte
 * differs.
 *
 * We only support S256 (the spec says "plain" is OPTIONAL and Anthropic
 * + Modelcontextprotocol best-practice is "S256 only"). Rejected
 * challenges throw `InvalidGrantError` upstream.
 */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false;
  const hash = createHash("sha256").update(verifier).digest();
  const expected = Buffer.from(hash).toString("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Loose URI check — we accept anything that parses as a URL. Used to
 * validate DCR `redirect_uris` and `redirect_uri` at the authorize +
 * token endpoints. Stricter checks (host allow-listing) would block
 * Claude.ai's evolving redirect host, so we keep it permissive and rely
 * on the user-side consent screen to be the real authorization barrier.
 *
 * Spec-required: `http://localhost*` IS allowed (helps dev clients).
 */
export function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (u.protocol === "http:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      // Only allow http for local dev redirects; production clients must
      // use https.
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Match a presented redirect_uri against the registered set. We do an
 * EXACT match — RFC 6749 §3.1.2 says full-string compare is required,
 * no path prefix shenanigans, no query-string ignoring.
 */
export function redirectUriRegistered(presented: string, registered: string[]): boolean {
  return registered.includes(presented);
}

/**
 * Public metadata document returned at
 * `/.well-known/oauth-authorization-server`. Origin is computed by the
 * route so we work on agentcoliseum.xyz, on Vercel preview URLs, and on
 * localhost without re-deploying.
 */
export function metadataDocument(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    response_types_supported: ["code"] as const,
    response_modes_supported: ["query"] as const,
    grant_types_supported: ["authorization_code", "refresh_token"] as const,
    code_challenge_methods_supported: ["S256"] as const,
    // Public client flow — no client_secret. The PKCE verifier IS the
    // proof-of-possession, which is the canonical MCP pattern.
    token_endpoint_auth_methods_supported: ["none"] as const,
    scopes_supported: ["mcp"] as const,
    // MCP-specific: tells the client this server speaks the MCP
    // protocol on its mcp endpoint.
    mcp_endpoint: `${origin}/api/mcp`,
  };
}
