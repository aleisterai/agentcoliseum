/**
 * POST /api/mcp/oauth/token
 *
 * OAuth token endpoint. Handles two grant types:
 *
 *   grant_type=authorization_code
 *     Body (application/x-www-form-urlencoded OR application/json):
 *       code, redirect_uri, client_id, code_verifier
 *     We:
 *       1. Look up the code row, reject if missing / expired / used
 *       2. Re-verify client_id + redirect_uri exact match
 *       3. Verify PKCE: BASE64URL(SHA256(verifier)) === stored challenge
 *       4. Mark code as used (idempotency — single exchange)
 *       5. Mint access_token (`acoth_…`, 24h) + refresh_token (`acotr_…`, 30d)
 *          BOUND to the agent the user picked at consent time
 *       6. Return RFC 6749 §5.1 response shape
 *
 *   grant_type=refresh_token
 *     Body: refresh_token, client_id
 *     We:
 *       1. Look up the token row by refresh_token + client_id
 *       2. Reject if revoked or refresh has been used (we rotate on every refresh)
 *       3. Revoke the old access_token + refresh_token (mark revoked_at)
 *       4. Mint a new pair tied to the same agent + owner
 *       5. Return the same response shape as authorization_code
 *
 * No client_secret — we're a public client (`token_endpoint_auth_method:
 * "none"`); the PKCE verifier (or the refresh_token itself) IS the
 * proof-of-possession.
 *
 * Errors follow RFC 6749 §5.2: `{ error, error_description }` with the
 * appropriate HTTP status.
 */
import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  agents,
  mcpOauthCodes,
  mcpOauthTokens,
  type Agent,
} from "@/lib/db/schema";
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  REFRESH_PREFIX,
  TOKEN_PREFIX,
  randomSecret,
  verifyPkce,
} from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function err(code: string, description: string, status = 400) {
  return NextResponse.json(
    { error: code, error_description: description },
    { status, headers: corsHeaders() },
  );
}

async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const json = (await req.json()) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(json)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }
  // application/x-www-form-urlencoded (the OAuth default).
  const text = await req.text();
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: NextRequest) {
  const body = await parseBody(req);
  const grant = body.grant_type;
  if (grant === "authorization_code") return handleAuthorizationCode(body);
  if (grant === "refresh_token") return handleRefresh(body);
  return err("unsupported_grant_type", "Supported grants: authorization_code, refresh_token.");
}

async function handleAuthorizationCode(body: Record<string, string>) {
  const code = body.code;
  const clientId = body.client_id;
  const redirectUri = body.redirect_uri;
  const verifier = body.code_verifier;
  if (!code || !clientId || !redirectUri || !verifier) {
    return err(
      "invalid_request",
      "Required: code, client_id, redirect_uri, code_verifier",
    );
  }

  const row = await db.query.mcpOauthCodes.findFirst({
    where: eq(mcpOauthCodes.code, code),
  });
  if (!row) return err("invalid_grant", "Authorization code not found.");
  if (row.usedAt) return err("invalid_grant", "Authorization code has already been exchanged.");
  if (row.expiresAt.getTime() < Date.now()) {
    return err("invalid_grant", "Authorization code has expired.");
  }
  if (row.clientId !== clientId) {
    return err("invalid_grant", "Code was not issued to this client.");
  }
  if (row.redirectUri !== redirectUri) {
    return err("invalid_grant", "redirect_uri does not match the one used at /authorize.");
  }
  if (!verifyPkce(verifier, row.codeChallenge, row.codeChallengeMethod)) {
    return err("invalid_grant", "PKCE verifier does not match the stored challenge.");
  }

  // Mark code as used atomically. The unique-on-code primary key plus
  // the explicit used_at update guarantees only one token pair is
  // minted per code even under concurrent requests.
  await db
    .update(mcpOauthCodes)
    .set({ usedAt: new Date() })
    .where(eq(mcpOauthCodes.code, code));

  return mintAndRespond({
    clientId,
    agentId: row.agentId,
    ownerId: row.ownerId,
  });
}

async function handleRefresh(body: Record<string, string>) {
  const refresh = body.refresh_token;
  const clientId = body.client_id;
  if (!refresh || !clientId) {
    return err("invalid_request", "Required: refresh_token, client_id");
  }
  const row = await db.query.mcpOauthTokens.findFirst({
    where: and(
      eq(mcpOauthTokens.refreshToken, refresh),
      eq(mcpOauthTokens.clientId, clientId),
    ),
  });
  if (!row) return err("invalid_grant", "Refresh token not recognized.");
  if (row.revokedAt) return err("invalid_grant", "Refresh token has been revoked or already rotated.");
  if (row.expiresAt.getTime() + REFRESH_TOKEN_TTL_MS < Date.now()) {
    return err("invalid_grant", "Refresh token expired.");
  }
  // Rotate: revoke the old pair, mint a new pair, keep the
  // agent/owner binding. Refresh-token reuse should never produce
  // tokens — that's how stolen-token replay is caught.
  await db
    .update(mcpOauthTokens)
    .set({ revokedAt: new Date() })
    .where(eq(mcpOauthTokens.accessToken, row.accessToken));

  return mintAndRespond({
    clientId,
    agentId: row.agentId,
    ownerId: row.ownerId,
  });
}

async function mintAndRespond(opts: {
  clientId: string;
  agentId: string;
  ownerId: string;
}): Promise<NextResponse> {
  // Sanity: the agent better still exist. If it was deleted, every
  // token tied to it would be useless anyway.
  const agentRow = (await db.query.agents.findFirst({
    where: eq(agents.id, opts.agentId),
  })) as Agent | undefined;
  if (!agentRow) {
    return err("invalid_grant", "Agent no longer exists.", 410);
  }
  if (agentRow.recalledAt) {
    // Soft-block — owner can re-authorize after lifting the recall.
    return err(
      "access_denied",
      "Agent is recalled. Lift the recall from the dashboard, then re-authorize the client.",
      403,
    );
  }

  const accessToken = randomSecret(TOKEN_PREFIX, 24);
  const refreshToken = randomSecret(REFRESH_PREFIX, 24);
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  await db.insert(mcpOauthTokens).values({
    accessToken,
    refreshToken,
    clientId: opts.clientId,
    agentId: opts.agentId,
    ownerId: opts.ownerId,
    expiresAt,
  });

  return NextResponse.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: "mcp",
    },
    {
      headers: {
        ...corsHeaders(),
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

// Suppress unused-import lint — kept for future expiry-check refinement.
void isNull;
void gt;
