/**
 * POST /api/mcp/oauth/register — Dynamic Client Registration (RFC 7591).
 *
 * Claude.ai (and any MCP client that walks the OAuth dance) calls this
 * BEFORE the authorize step to register itself as a client. We mint a
 * `client_id` (prefix `mcpc_`), persist the redirect URIs they declare,
 * and return the standard DCR response.
 *
 * We're a "public client" server — no client_secret is issued. The
 * proof-of-possession lives entirely in the PKCE verifier the client
 * presents at the token endpoint. This matches the MCP authorization
 * spec recommendation for browser-side / LLM-host integrations.
 *
 * No auth is required to register. The real authorization moment is
 * the consent screen at /oauth/authorize — that's where a real user
 * decides whether THIS client gets to act as THEIR agent.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { mcpOauthClients } from "@/lib/db/schema";
import {
  CLIENT_PREFIX,
  isValidRedirectUri,
  randomSecret,
} from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

const RegisterBody = z
  .object({
    redirect_uris: z.array(z.string()).min(1).max(8),
    client_name: z.string().max(200).optional(),
    token_endpoint_auth_method: z
      .enum(["none", "client_secret_basic", "client_secret_post"])
      .optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    scope: z.string().optional(),
  })
  .passthrough(); // RFC 7591 allows arbitrary extension members

function err(code: string, description: string, status = 400) {
  return NextResponse.json(
    { error: code, error_description: description },
    { status, headers: corsHeaders() },
  );
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("invalid_request", "Body must be valid JSON.");
  }
  const parsed = RegisterBody.safeParse(body);
  if (!parsed.success) {
    return err(
      "invalid_client_metadata",
      `Validation: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
    );
  }
  const data = parsed.data;

  // Validate every redirect_uri up front so a partially-bad list
  // doesn't end up persisted.
  for (const uri of data.redirect_uris) {
    if (!isValidRedirectUri(uri)) {
      return err(
        "invalid_redirect_uri",
        `redirect_uri "${uri}" is not a valid https URL (http allowed only for localhost / 127.0.0.1).`,
      );
    }
  }

  // We only support the "public client" path. If a client asks for
  // anything else, force `none` so we don't accidentally pretend a
  // secret exists.
  const authMethod = data.token_endpoint_auth_method ?? "none";

  const clientId = randomSecret(CLIENT_PREFIX, 16);
  const issuedAt = Math.floor(Date.now() / 1000);

  await db.insert(mcpOauthClients).values({
    clientId,
    clientName: data.client_name ?? null,
    redirectUris: data.redirect_uris,
    tokenEndpointAuthMethod: authMethod,
  });

  // RFC 7591 §3.2.1 response shape. We omit `client_secret` (public
  // client) and skip the management endpoint (no per-client edit /
  // revoke API right now — owners revoke via /dashboard's
  // connectors page).
  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_name: data.client_name ?? undefined,
      redirect_uris: data.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: authMethod,
      scope: "mcp",
    },
    { status: 201, headers: corsHeaders() },
  );
}
