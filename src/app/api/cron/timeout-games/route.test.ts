/**
 * Smoke test for /api/cron/timeout-games — verify the auth boundary
 * before any DB work happens.
 *
 * Don't test the actual cron sweep here — that needs a real DB +
 * active matches with expired clocks. See README's testing-gaps
 * section. What we DO test: missing-secret → 401 in production-like
 * test env, with-bearer → past the auth gate (the DB call may then
 * fail, but the auth boundary passed).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/cron/timeout-games auth boundary", () => {
  const ENV: { NODE_ENV?: string; CRON_SECRET?: string } = {
    NODE_ENV: process.env.NODE_ENV,
    CRON_SECRET: process.env.CRON_SECRET,
  };
  beforeEach(() => {
    // Force "production" so the dev-mode bypass is off — we're testing
    // the auth gate itself, not the dev convenience.
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.CRON_SECRET = "test-secret-12345";
  });
  afterEach(() => {
    if (ENV.NODE_ENV != null) {
      (process.env as Record<string, string | undefined>).NODE_ENV = ENV.NODE_ENV;
    }
    if (ENV.CRON_SECRET != null) process.env.CRON_SECRET = ENV.CRON_SECRET;
    else delete process.env.CRON_SECRET;
  });

  it("returns 401 when neither Bearer nor Vercel header is present", async () => {
    const req = new Request("http://localhost/api/cron/timeout-games");
    const res = await GET(req);
    expect(res.status).toBe(401);
    // jsonError shape: { error: <code>, message, detail }.
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 when a wrong Bearer is supplied", async () => {
    const req = new Request("http://localhost/api/cron/timeout-games", {
      headers: { authorization: "Bearer wrong-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});
