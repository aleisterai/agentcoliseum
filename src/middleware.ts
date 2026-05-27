/**
 * Next.js edge middleware.
 *
 * Today: generate a per-request UUID, expose it as `x-request-id` on
 * both the inbound request (forwarded to the Node route handler) and
 * the outbound response (so external callers and Vercel's log drain
 * can correlate request → log lines → response).
 *
 * The route handlers running on Node read `x-request-id` and seed the
 * AsyncLocalStorage via `withRequestContext`. See `src/lib/log.ts`.
 *
 * **Why generate here and not in the handler?** Two reasons:
 *
 *   1. One source of truth — every API hit gets exactly one ID, set
 *      before any other code runs. No risk of two different paths
 *      generating two different IDs for the same request.
 *
 *   2. Edge middleware sees ALL requests including static asset hits
 *      and Server Component renders, so future tracing extensions
 *      (page-render IDs, RSC streams) get the same plumbing for free.
 *
 * **Runtime note:** middleware runs on the Edge runtime. `crypto.randomUUID()`
 * is available there; `node:async_hooks` is NOT. That's why we only
 * SET the header here and let the Node-side handler import `log.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";

const REQUEST_ID_HEADER = "x-request-id";

export function middleware(req: NextRequest) {
  // Honour an inbound `x-request-id` if upstream (Vercel edge, a
  // gateway, or a curl caller doing its own correlation) already set
  // one. Otherwise mint a fresh UUID. Validate the inbound shape — a
  // hostile or malformed value shouldn't ride through as our internal
  // correlation key.
  const inbound = req.headers.get(REQUEST_ID_HEADER);
  const requestId =
    inbound && /^[A-Za-z0-9_-]{1,128}$/.test(inbound)
      ? inbound
      : crypto.randomUUID();

  // Clone the inbound headers so we can mutate. NextResponse.next()
  // with `request.headers` propagates these to the downstream handler.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

/**
 * Apply the middleware to /api/* only. Static assets, _next, and
 * favicon.ico don't need request-ID propagation and excluding them
 * cuts Edge invocations on every cached image fetch.
 *
 * Negative-lookahead syntax (Next.js matcher spec): match every path
 * except the ones starting with `_next`, `static`, or ending in a
 * file extension that's clearly an asset.
 */
export const config = {
  matcher: ["/api/:path*"],
};
