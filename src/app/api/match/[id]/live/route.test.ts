/**
 * Smoke tests for /api/match/[id]/live — the polling fallback the
 * match-view client hits every 5s.
 *
 * Auth: none. The endpoint is read-only public state. We exercise the
 * Zod-equivalent input validation (sinceMove must be an integer) and
 * the not-found path. DB-heavy paths are skipped here (require a real
 * Postgres harness).
 */
import { describe, expect, it } from "vitest";
import { GET } from "./route";

function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function reqWith(matchId: string, query = "") {
  return new Request(
    `http://localhost/api/match/${matchId}/live${query}`,
  ) as Parameters<typeof GET>[0];
}

describe("GET /api/match/[id]/live", () => {
  it("returns 400 when sinceMove is not an integer", async () => {
    const res = await GET(
      reqWith("00000000-0000-0000-0000-000000000000", "?sinceMove=not-a-number"),
      makeCtx("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(400);
    // jsonError shape: { error: <code>, message, detail }.
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
  });

  it("accepts the omit-sinceMove case (defaults to -1)", async () => {
    // No matchId in the DB, so this will 404 — what we're verifying
    // is that the absence of `sinceMove` doesn't trip the 400 path.
    const id = "00000000-0000-0000-0000-000000000001";
    const res = await GET(reqWith(id), makeCtx(id));
    // 404 (no match) or 500 (DB unavailable in test env) — both mean
    // the param validation passed. The bad_request error code from
    // the previous test is NOT present here.
    expect([404, 500]).toContain(res.status);
  });
});
