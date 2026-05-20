/**
 * AgentSelfPatchSchema — security boundary for what the LLM can edit about
 * its own agent via `coliseum_agent_profile_update` (which hits PATCH
 * /api/agents/me). Anything outside this schema is silently rejected with
 * a 400, NOT silently dropped — `.strict()` enforces that.
 */
import { describe, it, expect } from "vitest";
import { AgentSelfPatchSchema } from "./schema";

describe("AgentSelfPatchSchema", () => {
  describe("accepts cosmetic / linkage fields", () => {
    it("handle within 2-32 chars", () => {
      expect(AgentSelfPatchSchema.safeParse({ handle: "ab" }).success).toBe(true);
      expect(AgentSelfPatchSchema.safeParse({ handle: "x".repeat(32) }).success).toBe(true);
      expect(AgentSelfPatchSchema.safeParse({ handle: "chess-shark" }).success).toBe(true);
    });
    it("displayName within 1-80 chars", () => {
      expect(AgentSelfPatchSchema.safeParse({ displayName: "Chess Shark" }).success).toBe(true);
    });
    it("bio nullable, max 2000", () => {
      expect(AgentSelfPatchSchema.safeParse({ bio: null }).success).toBe(true);
      expect(AgentSelfPatchSchema.safeParse({ bio: "x".repeat(2000) }).success).toBe(true);
    });
    it("tokenCa accepts 0x… 40-hex", () => {
      const ok = "0x" + "a".repeat(40);
      expect(AgentSelfPatchSchema.safeParse({ tokenCa: ok }).success).toBe(true);
    });
    it("avatarUrl + website must be URLs (or null)", () => {
      expect(
        AgentSelfPatchSchema.safeParse({ avatarUrl: "https://example.com/a.png" }).success,
      ).toBe(true);
      expect(AgentSelfPatchSchema.safeParse({ website: null }).success).toBe(true);
    });
    it("socials object with optional x/github/farcaster", () => {
      expect(
        AgentSelfPatchSchema.safeParse({
          socials: { x: "ChessSharkBot", farcaster: "chessshark" },
        }).success,
      ).toBe(true);
    });
    it("partial patches (any single field)", () => {
      expect(AgentSelfPatchSchema.safeParse({ bio: "Just chess." }).success).toBe(true);
    });
  });

  describe("rejects malformed input", () => {
    it("handle too short", () => {
      expect(AgentSelfPatchSchema.safeParse({ handle: "a" }).success).toBe(false);
    });
    it("handle too long", () => {
      expect(AgentSelfPatchSchema.safeParse({ handle: "x".repeat(33) }).success).toBe(false);
    });
    it("tokenCa wrong format", () => {
      expect(AgentSelfPatchSchema.safeParse({ tokenCa: "not-an-address" }).success).toBe(false);
      expect(AgentSelfPatchSchema.safeParse({ tokenCa: "0x" + "z".repeat(40) }).success).toBe(false);
      expect(AgentSelfPatchSchema.safeParse({ tokenCa: "0x" + "a".repeat(39) }).success).toBe(false);
    });
    it("displayName empty", () => {
      expect(AgentSelfPatchSchema.safeParse({ displayName: "" }).success).toBe(false);
    });
    it("avatarUrl not a URL", () => {
      expect(AgentSelfPatchSchema.safeParse({ avatarUrl: "not a url" }).success).toBe(false);
    });
    it("bio over 2000 chars", () => {
      expect(AgentSelfPatchSchema.safeParse({ bio: "x".repeat(2001) }).success).toBe(false);
    });
  });

  describe("rejects security-sensitive fields the LLM should never set", () => {
    // The strict() schema rejects unknowns. These are the load-bearing
    // assertions: if any of these silently succeed in the future, the
    // LLM (which the owner does NOT fully trust) could mutate competitive
    // state, escape recall, or steal credentials.
    it.each([
      "id",
      "ownerId",
      "apiKey",
      "elo",
      "wins",
      "losses",
      "draws",
      "createdAt",
      "recalledAt",
      "recalledBy",
      "recallReason",
    ])("rejects unknown field '%s'", (field) => {
      const result = AgentSelfPatchSchema.safeParse({ [field]: "anything" });
      expect(result.success).toBe(false);
    });
  });

  describe("empty / unrelated input", () => {
    it("empty object is a valid (no-op) parse; route layer rejects it as bad_request", () => {
      // The route handler treats an empty patch as 400; the schema itself
      // doesn't — that's correct separation. Schema = "is this shape ok?",
      // route = "is this request useful?".
      expect(AgentSelfPatchSchema.safeParse({}).success).toBe(true);
    });
    it("non-object body fails", () => {
      expect(AgentSelfPatchSchema.safeParse("not an object").success).toBe(false);
      expect(AgentSelfPatchSchema.safeParse(null).success).toBe(false);
    });
  });
});
