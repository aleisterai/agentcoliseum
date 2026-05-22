/**
 * Tests for the voice-marker heuristic. Voice IS the product;
 * this check is the absolute floor (zero markers = reject).
 */
import { describe, expect, it } from "vitest";
import { checkVoiceMarkers } from "./heuristic";

describe("checkVoiceMarkers — happy path", () => {
  it("trash-talker passes with 'bro' present", () => {
    const r = checkVoiceMarkers(
      "Center. Obviously center. If you don't open col 3 in 2026 you're not even trying bro.",
      "trash-talker",
    );
    expect(r.ok).toBe(true);
  });

  it("calm-professor passes with 'instructive' present", () => {
    const r = checkVoiceMarkers(
      "An instructive position. The open three on row 1 can only be answered on one side.",
      "calm-professor",
    );
    expect(r.ok).toBe(true);
  });

  it("stoic-samurai passes with 'blade' present", () => {
    const r = checkVoiceMarkers(
      "Center. The blade falls where it must.",
      "stoic-samurai",
    );
    expect(r.ok).toBe(true);
  });

  it("anxious-nerd passes with 'I think' present", () => {
    const r = checkVoiceMarkers(
      "Okay so... center? I think? Everyone says you have to play col 3 first.",
      "anxious-nerd",
    );
    expect(r.ok).toBe(true);
  });

  it("degen passes with 'wagmi' present", () => {
    const r = checkVoiceMarkers(
      "col 3 is the alpha opener fr fr. ngmi if you fade this. WAGMI.",
      "degen",
    );
    expect(r.ok).toBe(true);
  });
});

describe("checkVoiceMarkers — rejection path", () => {
  it("rejects neutral analytical prose against trash-talker", () => {
    // The actual failure from the production screenshot: trash-talker
    // voice but reasoning reads like calm-professor.
    const r = checkVoiceMarkers(
      "Stack center for parity. Yellow on row 3 claims P1's natural endgame threat row.",
      "trash-talker",
    );
    expect(r.ok).toBe(false);
    expect(r.voicePackId).toBe("trash-talker");
    expect(r.expectedMarkers).toContain("bro");
    expect(r.got).toMatch(/Stack center/);
  });

  it("rejects trash-talker prose against stoic-samurai", () => {
    // Voice mismatch in the other direction.
    const r = checkVoiceMarkers(
      "Bro just imagine getting cooked on move 4. EZ.",
      "stoic-samurai",
    );
    expect(r.ok).toBe(false);
    expect(r.voicePackId).toBe("stoic-samurai");
    expect(r.expectedMarkers).toContain("blade");
  });
});

describe("checkVoiceMarkers — skip path", () => {
  it("skips when voicePackId is null (custom voice)", () => {
    // Owner is managing voice themselves; no preset markers to
    // enforce against. Accept whatever the agent submits.
    const r = checkVoiceMarkers(
      "Stack center for parity. Yellow on row 3.",
      null,
    );
    expect(r.ok).toBe(true);
  });

  it("skips when voicePackId is unknown / custom string", () => {
    const r = checkVoiceMarkers(
      "Stack center for parity. Yellow on row 3.",
      "my-custom-voice",
    );
    expect(r.ok).toBe(true);
  });
});

describe("checkVoiceMarkers — case insensitivity", () => {
  it("matches case-insensitively", () => {
    const r = checkVoiceMarkers(
      "CENTER. OBVIOUSLY CENTER. EZ WIN.",
      "trash-talker",
    );
    expect(r.ok).toBe(true);
  });
});
