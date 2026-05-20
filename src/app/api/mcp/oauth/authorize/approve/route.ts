/**
 * POST /api/mcp/oauth/authorize/approve
 *
 * Server side of the consent screen. Called by /oauth/authorize when
 * the user clicks "Approve." Verifies:
 *
 *   - Privy session is valid + the wallet has an owner row
 *   - The chosen agent belongs to that owner
 *   - The client_id is registered
 *   - The presented redirect_uri matches one of the client's
 *     registered redirect_uris EXACTLY (RFC 6749 §3.1.2 — no path
 *     prefix shenanigans)
 *   - code_challenge_method is S256 (server-side belt-and-braces — the
 *     page-side check is just UX)
 *
 * On success we mint a one-time authorization code (10-minute TTL,
 * `acoc_…` prefix), persist it with the PKCE challenge + agentId, and
 * return the full redirect URL the browser should follow. State + code
 * are appended per RFC 6749 §4.1.2.
 *
 * Failure modes return JSON `{ error, error_description }`. The page
 * surfaces them inline so the user can retry or hit Deny.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getAddress } from "viem";
import { db } from "@/lib/db/client";
import { agents, mcpOauthClients, mcpOauthCodes, owners } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import {
  CODE_PREFIX,
  CODE_TTL_MS,
  isValidRedirectUri,
  randomSecret,
  redirectUriRegistered,
} from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

const Body = z.object({
  agentId: z.string().uuid(),
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
});

function jsonErr(code: string, description: string, status = 400) {
  return NextResponse.json({ error: code, error_description: description }, { status });
}

export async function POST(req: Request) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) {
      throw new UnauthorizedError("unauthorized", "Privy session required");
    }
    const checksummed = getAddress(wallet);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonErr("invalid_request", "Body must be valid JSON.");
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      return jsonErr(
        "invalid_request",
        `Validation: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
      );
    }
    const v = parsed.data;

    if (!isValidRedirectUri(v.redirect_uri)) {
      return jsonErr("invalid_request", "redirect_uri is not a valid URL.");
    }

    // 1. Owner row.
    const owner = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (!owner) {
      return jsonErr(
        "access_denied",
        "No owner row for this wallet. POST /api/owners/me first.",
        403,
      );
    }

    // 2. Agent must belong to this owner.
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.id, v.agentId), eq(agents.ownerId, owner.id)),
    });
    if (!agent) {
      return jsonErr("access_denied", "Agent not found on this wallet.", 403);
    }
    if (agent.recalledAt) {
      return jsonErr(
        "access_denied",
        "Agent is currently recalled. Lift the recall from the dashboard first.",
        403,
      );
    }

    // 3. Client + redirect_uri.
    const client = await db.query.mcpOauthClients.findFirst({
      where: eq(mcpOauthClients.clientId, v.client_id),
    });
    if (!client) {
      return jsonErr("invalid_client", "client_id is not registered.");
    }
    if (!redirectUriRegistered(v.redirect_uri, client.redirectUris)) {
      return jsonErr(
        "invalid_redirect_uri",
        "redirect_uri does not match any registered URI for this client.",
      );
    }

    // 4. Mint the code + persist it.
    const code = randomSecret(CODE_PREFIX, 24);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await db.insert(mcpOauthCodes).values({
      code,
      clientId: client.clientId,
      agentId: agent.id,
      ownerId: owner.id,
      redirectUri: v.redirect_uri,
      codeChallenge: v.code_challenge,
      codeChallengeMethod: v.code_challenge_method,
      scope: v.scope ?? null,
      expiresAt,
    });

    // 5. Build the redirect URL the browser should follow.
    const redirect = new URL(v.redirect_uri);
    redirect.searchParams.set("code", code);
    if (v.state) redirect.searchParams.set("state", v.state);

    return NextResponse.json({ redirect: redirect.toString() });
  } catch (err) {
    return errorResponse(err);
  }
}
