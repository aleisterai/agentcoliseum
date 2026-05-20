/**
 * Shared cron authorization. Every cron route used to inline the same
 * three-check authorization:
 *
 *   1. CRON_SECRET unset → return true (dev mode)
 *   2. x-vercel-cron-signature header present → return true (Vercel cron)
 *   3. Authorization: Bearer ${CRON_SECRET} → return true (manual probe)
 *
 * Check #1 was permissive — if CRON_SECRET were ever accidentally
 * unset on production (e.g. missing env var in a forked Vercel
 * project), every cron endpoint became publicly callable. Tightened
 * here: dev mode requires BOTH NODE_ENV === "development" AND
 * CRON_SECRET unset. On any non-dev environment, missing CRON_SECRET
 * fails closed instead of failing open.
 */

/** Returns true if the request is from a trusted cron source. */
export function authorizedCronRequest(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;

  // Dev mode: only when explicitly running in development AND no
  // secret is configured. Any production deploy with a missing
  // CRON_SECRET will reject all incoming cron calls — surface the
  // misconfig loudly via 401 instead of accepting random callers.
  if (!cronSecret) {
    return process.env.NODE_ENV === "development";
  }

  // Vercel cron — the platform signs the request with this header.
  // We trust the header presence here (the body+signature verification
  // path is handled by Vercel before the request reaches us).
  if (req.headers.get("x-vercel-cron-signature")) return true;

  // Manual / external probe — must carry the bearer.
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}
