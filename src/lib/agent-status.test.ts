import { describe, expect, it } from "vitest";
import {
  ACTIVE_WINDOW_MS,
  AGENT_STATUS_VALUES,
  deriveAgentStatus,
  statusChip,
} from "./agent-status";

describe("deriveAgentStatus", () => {
  const NOW = Date.parse("2026-05-19T20:00:00Z");

  it("returns 'recalled' when recalledAt is set, regardless of lastMcpAt", () => {
    expect(
      deriveAgentStatus({
        recalledAt: new Date(NOW - 1000),
        lastMcpAt: new Date(NOW - 1000),
        now: NOW,
      }),
    ).toBe("recalled");
    // Even with a never-connected + recalled agent, recall wins.
    expect(
      deriveAgentStatus({
        recalledAt: new Date(NOW - 10_000),
        lastMcpAt: null,
        now: NOW,
      }),
    ).toBe("recalled");
  });

  it("returns 'not_connected' when lastMcpAt is null and not recalled", () => {
    expect(
      deriveAgentStatus({ recalledAt: null, lastMcpAt: null, now: NOW }),
    ).toBe("not_connected");
  });

  it("returns 'active' when lastMcpAt is within the 24h window", () => {
    expect(
      deriveAgentStatus({
        recalledAt: null,
        lastMcpAt: new Date(NOW - 1000),
        now: NOW,
      }),
    ).toBe("active");
    expect(
      deriveAgentStatus({
        recalledAt: null,
        lastMcpAt: new Date(NOW - ACTIVE_WINDOW_MS + 1),
        now: NOW,
      }),
    ).toBe("active");
  });

  it("returns 'idle' when lastMcpAt is >24h ago", () => {
    expect(
      deriveAgentStatus({
        recalledAt: null,
        lastMcpAt: new Date(NOW - ACTIVE_WINDOW_MS - 1),
        now: NOW,
      }),
    ).toBe("idle");
    expect(
      deriveAgentStatus({
        recalledAt: null,
        lastMcpAt: new Date(NOW - 7 * 24 * 60 * 60 * 1000),
        now: NOW,
      }),
    ).toBe("idle");
  });

  it("accepts ISO strings for either timestamp", () => {
    const iso = new Date(NOW - 5000).toISOString();
    expect(
      deriveAgentStatus({ recalledAt: null, lastMcpAt: iso, now: NOW }),
    ).toBe("active");
    expect(
      deriveAgentStatus({
        recalledAt: new Date(NOW - 60_000).toISOString(),
        lastMcpAt: iso,
        now: NOW,
      }),
    ).toBe("recalled");
  });

  it("treats malformed ISO strings as null (defensive)", () => {
    expect(
      deriveAgentStatus({ recalledAt: null, lastMcpAt: "not-a-date", now: NOW }),
    ).toBe("not_connected");
  });
});

describe("statusChip", () => {
  it("produces a label + tone for every status value", () => {
    for (const s of AGENT_STATUS_VALUES) {
      const c = statusChip(s);
      expect(c.label).toMatch(/[●◐○▲]/);
      expect(["green", "muted", "ox"]).toContain(c.tone);
    }
  });

  it("uses green only for active, ox only for recalled", () => {
    expect(statusChip("active").tone).toBe("green");
    expect(statusChip("idle").tone).toBe("muted");
    expect(statusChip("not_connected").tone).toBe("muted");
    expect(statusChip("recalled").tone).toBe("ox");
  });
});
