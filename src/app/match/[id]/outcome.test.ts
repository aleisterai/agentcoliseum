import { describe, expect, it } from "vitest";
import { classifyOutcome, describeOutcomeDetail } from "./outcome";

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";

describe("classifyOutcome", () => {
  it("draw — explicit engine draw", () => {
    expect(
      classifyOutcome({
        mode: "free",
        winnerAgentId: null,
        resultReason: "draw",
        p1Id: P1,
        p2Id: P2,
      }),
    ).toEqual({ kind: "draw", reason: "draw" });
  });

  it("win-p1 — p1 won naturally", () => {
    expect(
      classifyOutcome({
        mode: "paid",
        winnerAgentId: P1,
        resultReason: "natural",
        p1Id: P1,
        p2Id: P2,
      }),
    ).toEqual({ kind: "win-p1", reason: "natural" });
  });

  it("win-p2 — p2 won by time forfeit", () => {
    expect(
      classifyOutcome({
        mode: "paid",
        winnerAgentId: P2,
        resultReason: "time_forfeit",
        p1Id: P1,
        p2Id: P2,
      }),
    ).toEqual({ kind: "win-p2", reason: "time_forfeit" });
  });

  it("bot-won — system-mode, human timed out (the original screenshot bug)", () => {
    // Match record: mode=system, p1=user-agent, p2=null,
    // winner_agent_id=null, result_reason=time_forfeit, current
    // player was p1. Previously rendered as 'DRAW' which was wrong.
    expect(
      classifyOutcome({
        mode: "system",
        winnerAgentId: null,
        resultReason: "time_forfeit",
        p1Id: P1,
        p2Id: null,
      }),
    ).toEqual({ kind: "bot-won", reason: "time_forfeit" });
  });

  it("bot-won — system-mode, bot won naturally (e.g. checkmate)", () => {
    expect(
      classifyOutcome({
        mode: "system",
        winnerAgentId: null,
        resultReason: "natural",
        p1Id: P1,
        p2Id: null,
      }),
    ).toEqual({ kind: "bot-won", reason: "natural" });
  });

  it("bot-won — system-mode, human submitted two illegal moves", () => {
    expect(
      classifyOutcome({
        mode: "system",
        winnerAgentId: null,
        resultReason: "invalid_move_forfeit",
        p1Id: P1,
        p2Id: null,
      }),
    ).toEqual({ kind: "bot-won", reason: "invalid_move_forfeit" });
  });

  it("bot-won is NOT triggered when result is draw (system match can still draw)", () => {
    // Both sides in a deterministic engine could stalemate even in
    // system mode. That's a real draw, not a bot-won loss.
    expect(
      classifyOutcome({
        mode: "system",
        winnerAgentId: null,
        resultReason: "draw",
        p1Id: P1,
        p2Id: null,
      }),
    ).toEqual({ kind: "draw", reason: "draw" });
  });

  it("abandoned — operator close path", () => {
    expect(
      classifyOutcome({
        mode: "paid",
        winnerAgentId: null,
        resultReason: "abandoned",
        p1Id: P1,
        p2Id: P2,
      }),
    ).toEqual({ kind: "abandoned", reason: "abandoned" });
  });

  it("unknown — winner uuid doesn't match either side (data corruption)", () => {
    expect(
      classifyOutcome({
        mode: "paid",
        winnerAgentId: "33333333-3333-3333-3333-333333333333",
        resultReason: "natural",
        p1Id: P1,
        p2Id: P2,
      }),
    ).toEqual({ kind: "unknown", reason: "natural" });
  });

  it("unknown — null winner + null reason + free mode (not a bot match)", () => {
    // Should never happen but if it does we surface as unknown rather
    // than silently labeling as draw.
    expect(
      classifyOutcome({
        mode: "free",
        winnerAgentId: null,
        resultReason: null,
        p1Id: P1,
        p2Id: P2,
      }),
    ).toEqual({ kind: "unknown", reason: null });
  });
});

describe("describeOutcomeDetail", () => {
  const agents = { p1Handle: "alpha", p2Handle: "beta" };

  it("attributes time_forfeit to the LOSER, not the winner", () => {
    expect(
      describeOutcomeDetail(
        { kind: "win-p1", reason: "time_forfeit" },
        agents,
      ),
    ).toBe("@beta ran out of time"); // beta lost on time, alpha won
    expect(
      describeOutcomeDetail(
        { kind: "win-p2", reason: "time_forfeit" },
        agents,
      ),
    ).toBe("@alpha ran out of time"); // alpha lost on time, beta won
  });

  it("attributes bot-won time_forfeit to the human (p1)", () => {
    expect(
      describeOutcomeDetail(
        { kind: "bot-won", reason: "time_forfeit" },
        { p1Handle: "alpha", p2Handle: null },
      ),
    ).toBe("@alpha ran out of time");
  });

  it("attributes invalid_move_forfeit to the LOSER", () => {
    expect(
      describeOutcomeDetail(
        { kind: "win-p1", reason: "invalid_move_forfeit" },
        agents,
      ),
    ).toBe("@beta forfeited on two illegal moves");
  });

  it("renders bot natural as 'system bot won'", () => {
    expect(
      describeOutcomeDetail(
        { kind: "bot-won", reason: "natural" },
        { p1Handle: "alpha", p2Handle: null },
      ),
    ).toBe("system bot won");
  });

  it("renders draw cleanly", () => {
    expect(describeOutcomeDetail({ kind: "draw", reason: "draw" }, agents)).toBe(
      "draw",
    );
  });

  it("falls back to a neutral message for unknown reasons", () => {
    expect(
      describeOutcomeDetail({ kind: "unknown", reason: "weird-string" }, agents),
    ).toBe("weird-string");
    expect(
      describeOutcomeDetail({ kind: "unknown", reason: null }, agents),
    ).toBe("match concluded");
  });
});
