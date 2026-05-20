/**
 * Smoke tests for the shared cron-auth helper. Locks the fail-closed
 * behavior + the three accept paths (dev mode, Vercel header, bearer).
 *
 * Runs with no DB, no env reads beyond NODE_ENV/CRON_SECRET; safe to
 * exercise in CI without a Postgres harness.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizedCronRequest } from "./cron-auth";

function reqWith(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/cron/foo", { headers });
}

describe("authorizedCronRequest", () => {
  const ENV: { NODE_ENV?: string; CRON_SECRET?: string } = {
    NODE_ENV: process.env.NODE_ENV,
    CRON_SECRET: process.env.CRON_SECRET,
  };
  beforeEach(() => {
    delete process.env.CRON_SECRET;
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
  });
  afterEach(() => {
    // Restore originals so vitest doesn't bleed test state into other files.
    if (ENV.NODE_ENV != null) {
      (process.env as Record<string, string | undefined>).NODE_ENV = ENV.NODE_ENV;
    }
    if (ENV.CRON_SECRET != null) process.env.CRON_SECRET = ENV.CRON_SECRET;
  });

  describe("when CRON_SECRET is unset", () => {
    it("accepts requests in development", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "development";
      expect(authorizedCronRequest(reqWith())).toBe(true);
    });

    it("REJECTS requests in production (fail-closed)", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      expect(authorizedCronRequest(reqWith())).toBe(false);
    });

    it("REJECTS requests in test (treats test as production)", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";
      expect(authorizedCronRequest(reqWith())).toBe(false);
    });

    it("REJECTS requests when NODE_ENV is unset entirely", () => {
      expect(authorizedCronRequest(reqWith())).toBe(false);
    });
  });

  describe("when CRON_SECRET is set", () => {
    beforeEach(() => {
      process.env.CRON_SECRET = "shh-its-a-secret";
    });

    it("accepts the matching Bearer header", () => {
      expect(
        authorizedCronRequest(
          reqWith({ authorization: "Bearer shh-its-a-secret" }),
        ),
      ).toBe(true);
    });

    it("REJECTS a wrong bearer", () => {
      expect(
        authorizedCronRequest(reqWith({ authorization: "Bearer wrong-value" })),
      ).toBe(false);
    });

    it("accepts the Vercel cron signature header without bearer", () => {
      expect(
        authorizedCronRequest(reqWith({ "x-vercel-cron-signature": "any-value" })),
      ).toBe(true);
    });

    it("REJECTS requests with no auth headers at all", () => {
      expect(authorizedCronRequest(reqWith())).toBe(false);
    });

    it("dev-mode bypass is OFF when CRON_SECRET is set", () => {
      // Even in development, if a secret is configured we require it.
      (process.env as Record<string, string | undefined>).NODE_ENV = "development";
      expect(authorizedCronRequest(reqWith())).toBe(false);
    });
  });
});
