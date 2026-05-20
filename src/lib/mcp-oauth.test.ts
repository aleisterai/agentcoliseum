/**
 * Unit tests for the MCP OAuth helpers. These are the bits that have
 * security implications (PKCE verification, redirect URI matching) so
 * they're locked in tests before the endpoints touch them.
 */
import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  ACCESS_TOKEN_TTL_MS,
  CODE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  isValidRedirectUri,
  metadataDocument,
  randomSecret,
  redirectUriRegistered,
  TOKEN_PREFIX,
  REFRESH_PREFIX,
  CODE_PREFIX,
  CLIENT_PREFIX,
  verifyPkce,
} from "./mcp-oauth";

describe("mcp-oauth · randomSecret", () => {
  it("prefixes and produces base64url with no padding", () => {
    const s = randomSecret("test_", 16);
    expect(s.startsWith("test_")).toBe(true);
    expect(s).not.toMatch(/=/);
    expect(s).not.toMatch(/[+/]/);
    // base64url of 16 bytes is 22 chars; with prefix "test_" total 27.
    expect(s.length).toBe("test_".length + 22);
  });

  it("does not collide across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(randomSecret("x_", 16));
    expect(seen.size).toBe(1000);
  });
});

describe("mcp-oauth · verifyPkce", () => {
  function challengeFor(verifier: string): string {
    return Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  }

  it("accepts a correct S256 verifier", () => {
    const v = randomBytes(32).toString("base64url");
    expect(verifyPkce(v, challengeFor(v), "S256")).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    const v = randomBytes(32).toString("base64url");
    const bad = randomBytes(32).toString("base64url");
    expect(verifyPkce(bad, challengeFor(v), "S256")).toBe(false);
  });

  it("rejects an empty verifier", () => {
    expect(verifyPkce("", challengeFor("anything"), "S256")).toBe(false);
  });

  it("refuses any method other than S256 (no plain)", () => {
    const v = "abc123";
    expect(verifyPkce(v, v, "plain")).toBe(false);
    expect(verifyPkce(v, challengeFor(v), "S512")).toBe(false);
    expect(verifyPkce(v, challengeFor(v), "")).toBe(false);
  });
});

describe("mcp-oauth · isValidRedirectUri", () => {
  it("accepts https URLs on any host", () => {
    expect(isValidRedirectUri("https://claude.ai/callback")).toBe(true);
    expect(isValidRedirectUri("https://chatgpt.com/connectors/cb?id=1")).toBe(true);
  });
  it("accepts http only on localhost / 127.0.0.1 (for dev)", () => {
    expect(isValidRedirectUri("http://localhost:3000/cb")).toBe(true);
    expect(isValidRedirectUri("http://127.0.0.1:8080/cb")).toBe(true);
  });
  it("rejects http on any other host", () => {
    expect(isValidRedirectUri("http://evil.example/cb")).toBe(false);
  });
  it("rejects non-URL strings", () => {
    expect(isValidRedirectUri("not-a-url")).toBe(false);
    expect(isValidRedirectUri("")).toBe(false);
  });
  it("rejects non-http schemes", () => {
    expect(isValidRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isValidRedirectUri("file:///etc/passwd")).toBe(false);
    expect(isValidRedirectUri("ftp://example.com/cb")).toBe(false);
  });
});

describe("mcp-oauth · redirectUriRegistered", () => {
  it("matches exactly, no path-prefix tricks", () => {
    const registered = ["https://claude.ai/callback", "https://claude.ai/cb2"];
    expect(redirectUriRegistered("https://claude.ai/callback", registered)).toBe(true);
    expect(redirectUriRegistered("https://claude.ai/callback?extra=1", registered)).toBe(false);
    expect(redirectUriRegistered("https://claude.ai/callback/", registered)).toBe(false);
    expect(redirectUriRegistered("https://claude.ai/callback#fragment", registered)).toBe(false);
  });
  it("rejects host-mismatches even when path matches", () => {
    expect(
      redirectUriRegistered("https://evil.example/callback", ["https://claude.ai/callback"]),
    ).toBe(false);
  });
});

describe("mcp-oauth · metadataDocument", () => {
  it("returns origin-relative endpoints", () => {
    const doc = metadataDocument("https://agentcoliseum.xyz");
    expect(doc.issuer).toBe("https://agentcoliseum.xyz");
    expect(doc.authorization_endpoint).toBe("https://agentcoliseum.xyz/oauth/authorize");
    expect(doc.token_endpoint).toBe("https://agentcoliseum.xyz/api/mcp/oauth/token");
    expect(doc.registration_endpoint).toBe(
      "https://agentcoliseum.xyz/api/mcp/oauth/register",
    );
    expect(doc.mcp_endpoint).toBe("https://agentcoliseum.xyz/api/mcp");
  });
  it("advertises S256-only PKCE and code-flow only", () => {
    const doc = metadataDocument("https://x");
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

describe("mcp-oauth · TTL constants", () => {
  it("uses the spec-friendly TTLs documented in the helpers file", () => {
    expect(CODE_TTL_MS).toBe(10 * 60 * 1000);
    expect(ACCESS_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(REFRESH_TOKEN_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it("has stable token prefixes (greppable from logs)", () => {
    expect(TOKEN_PREFIX).toBe("acoth_");
    expect(REFRESH_PREFIX).toBe("acotr_");
    expect(CODE_PREFIX).toBe("acoc_");
    expect(CLIENT_PREFIX).toBe("mcpc_");
  });
});
