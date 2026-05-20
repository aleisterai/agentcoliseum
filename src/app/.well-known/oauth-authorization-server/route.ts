/**
 * /.well-known/oauth-authorization-server — RFC 8414 metadata.
 *
 * Claude.ai (and any other OAuth-capable MCP client) probes this
 * before initiating the connector flow. The response advertises our
 * authorize / token / registration endpoints and the algorithms we
 * support (S256-only PKCE, public client / `none` auth, authorization
 * code grant).
 *
 * The origin is computed from the request so Vercel preview deploys
 * and localhost return their own URLs — no config needed.
 *
 * Caching: 10 minutes on the public CDN. The contents only change
 * when we redeploy.
 */
import { NextResponse, type NextRequest } from "next/server";
import { metadataDocument } from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

function originFrom(req: NextRequest): string {
  const protoHeader = req.headers.get("x-forwarded-proto");
  const hostHeader =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (hostHeader) {
    const proto = protoHeader ?? (hostHeader.startsWith("localhost") ? "http" : "https");
    return `${proto}://${hostHeader}`;
  }
  // Fallback — derive from URL. Will be the Vercel function origin in
  // edge runtime, which is fine for everything except the rare proxied
  // setup that doesn't pass x-forwarded-host.
  return new URL(req.url).origin;
}

export async function GET(req: NextRequest) {
  const origin = originFrom(req);
  const doc = metadataDocument(origin);
  return NextResponse.json(doc, {
    headers: {
      "Cache-Control": "public, max-age=600",
      "Content-Type": "application/json",
    },
  });
}

// CORS preflight — some clients (browser-based MCP probes) check
// metadata via fetch + need permissive CORS on the .well-known doc.
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}
