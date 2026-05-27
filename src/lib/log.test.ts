/**
 * Tests for the structured-logging foundation in src/lib/log.ts.
 *
 * Focus is on the AsyncLocalStorage plumbing — `withRequestContext`
 * actually seeds the store, `getRequestContext` reads back what was
 * set, nesting merges fields rather than clobbering them.
 *
 * The pino logger instance itself is exercised by the demo migration
 * in flow/match.ts; verifying its output shape would require
 * intercepting the underlying stream and isn't worth the test
 * complexity — pino's own suite covers the formatter.
 */
import { describe, expect, it } from "vitest";
import {
  getRequestContext,
  REQUEST_ID_HEADER,
  withRequestContext,
  log,
} from "./log";

describe("withRequestContext / getRequestContext", () => {
  it("returns an empty object outside any wrap", () => {
    // Important: callers can safely spread `getRequestContext()` into a
    // log payload without a null check. Verifies the public contract.
    expect(getRequestContext()).toEqual({});
  });

  it("seeds requestId for code running inside the wrap", async () => {
    let observed: ReturnType<typeof getRequestContext> | null = null;
    await withRequestContext({ requestId: "req-abc" }, async () => {
      observed = getRequestContext();
    });
    expect(observed).toEqual({ requestId: "req-abc" });
  });

  it("propagates across awaits inside the wrap", async () => {
    // The whole point of AsyncLocalStorage — context survives any
    // number of awaited microtasks. If it didn't, the logger mixin
    // would lose the requestId between handler entry and the deep
    // helper that actually emits the error.
    await withRequestContext({ requestId: "req-await" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getRequestContext()).toEqual({ requestId: "req-await" });
      await Promise.resolve();
      expect(getRequestContext()).toEqual({ requestId: "req-await" });
    });
  });

  it("carries optional agentId and matchId fields", async () => {
    await withRequestContext(
      { requestId: "req-1", agentId: "ag-1", matchId: "m-1" },
      async () => {
        expect(getRequestContext()).toEqual({
          requestId: "req-1",
          agentId: "ag-1",
          matchId: "m-1",
        });
      },
    );
  });

  it("merges fields when nested, with the inner call winning per-field", async () => {
    // Real use: the route entry seeds requestId; once the bearer is
    // resolved, the inner wrap layers agentId on top. We need both
    // fields visible inside the inner scope.
    await withRequestContext({ requestId: "outer-req" }, async () => {
      expect(getRequestContext()).toEqual({ requestId: "outer-req" });

      await withRequestContext({ agentId: "inner-agent" }, async () => {
        expect(getRequestContext()).toEqual({
          requestId: "outer-req",
          agentId: "inner-agent",
        });
      });

      // After the inner scope exits, only the outer fields remain.
      expect(getRequestContext()).toEqual({ requestId: "outer-req" });
    });
  });

  it("lets the inner call override a specific field", async () => {
    // Defensive: if a nested wrap explicitly re-sets requestId
    // (unusual but legal), the inner value wins for code inside it.
    await withRequestContext(
      { requestId: "outer", agentId: "outer-agent" },
      async () => {
        await withRequestContext({ requestId: "inner" }, async () => {
          expect(getRequestContext()).toEqual({
            requestId: "inner",
            agentId: "outer-agent", // outer agentId still visible
          });
        });
      },
    );
  });

  it("isolates context between concurrent wraps", async () => {
    // Critical correctness check: two requests arriving at the same
    // time must not see each other's IDs. If ALS were broken, this
    // test would catch the cross-contamination.
    const [a, b] = await Promise.all([
      withRequestContext({ requestId: "req-A" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getRequestContext().requestId;
      }),
      withRequestContext({ requestId: "req-B" }, async () => {
        await new Promise((r) => setTimeout(r, 2));
        return getRequestContext().requestId;
      }),
    ]);
    expect(a).toBe("req-A");
    expect(b).toBe("req-B");
  });

  it("returns the value produced by fn", async () => {
    // The wrap is transparent — handlers return their normal value,
    // we shouldn't need a hidden out-parameter.
    const result = await withRequestContext({ requestId: "r" }, async () => {
      return { ok: true, count: 7 };
    });
    expect(result).toEqual({ ok: true, count: 7 });
  });

  it("propagates exceptions thrown inside fn", async () => {
    // The wrap must not swallow errors — handlers depend on throws
    // to bubble up to the route's catch block.
    await expect(
      withRequestContext({ requestId: "r" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("REQUEST_ID_HEADER constant", () => {
  it("is the lowercase header name used by middleware + route handlers", () => {
    // Exported as a constant so middleware.ts and route entries can't
    // drift on the spelling — assert the public contract here.
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });
});

describe("log (pino instance)", () => {
  it("exposes the standard pino logging methods", () => {
    // Smoke test: we don't actually want to assert pino's output
    // shape (it has its own test suite), but we DO want a sanity
    // check that what we export is in fact a logger. If the makeLogger
    // factory ever fails to construct, this catches it.
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.debug).toBe("function");
  });
});
