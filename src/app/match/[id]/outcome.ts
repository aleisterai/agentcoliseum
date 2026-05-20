/**
 * Pure decision function that maps a finalized match's raw fields to
 * the spectator-banner outcome. Extracted from WinnerBanner so the
 * logic can be unit-tested without booting React, and so every other
 * surface (OG cards, feed entries, telemetry rollups) that classifies
 * an outcome reaches the same answer.
 *
 * The hard-won truth here is that **a null `winnerAgentId` is not a
 * draw**. In system-mode matches the bot has no agent record (p2 is
 * NULL on the row), so when the bot wins — by natural game-over, by
 * the human timing out, or by the human submitting two illegal moves
 * — the column stays null. Previously the banner treated any
 * null-winner as a draw, which produced bizarre "DRAW · opponent ran
 * out of time" copy. The five outcome kinds below capture every real
 * resolution path:
 *
 *   kind:"win-p1"    | "win-p2"    — one of the recorded agents won
 *   kind:"bot-won"                  — system bot won (system mode, p2 null)
 *   kind:"draw"                    — explicit engine draw
 *   kind:"abandoned"               — operator close / refund path
 *   kind:"unknown"                 — server data is inconsistent
 */

export type MatchOutcome =
  | { kind: "win-p1"; reason: string | null }
  | { kind: "win-p2"; reason: string | null }
  | { kind: "bot-won"; reason: string | null }
  | { kind: "draw"; reason: string | null }
  | { kind: "abandoned"; reason: string | null }
  | { kind: "unknown"; reason: string | null };

export interface OutcomeInput {
  mode: "free" | "paid" | "system";
  winnerAgentId: string | null;
  resultReason: string | null;
  p1Id: string | null;
  p2Id: string | null;
}

export function classifyOutcome(input: OutcomeInput): MatchOutcome {
  const { mode, winnerAgentId, resultReason, p1Id, p2Id } = input;

  if (resultReason === "draw") {
    return { kind: "draw", reason: resultReason };
  }
  if (resultReason === "abandoned") {
    return { kind: "abandoned", reason: resultReason };
  }
  if (winnerAgentId != null) {
    if (winnerAgentId === p1Id) return { kind: "win-p1", reason: resultReason };
    if (winnerAgentId === p2Id) return { kind: "win-p2", reason: resultReason };
    // winnerAgentId set but doesn't match either side — data corruption.
    return { kind: "unknown", reason: resultReason };
  }
  // winnerAgentId is null AND it's not a draw / abandoned. The only
  // legitimate way this happens is system-mode where p2 is null and
  // the bot won.
  if (mode === "system" && p2Id === null) {
    return { kind: "bot-won", reason: resultReason };
  }
  // Anything else is a server bug — log it but keep the UI sane.
  return { kind: "unknown", reason: resultReason };
}

/**
 * Render-friendly subtitle line that ALWAYS attributes the action to
 * the correct side. The old `describeReason(loser)` helper assumed
 * the loser was an agent; for `bot-won` outcomes the loser is the
 * recorded human and the actor is the system bot.
 */
export function describeOutcomeDetail(
  outcome: MatchOutcome,
  agents: { p1Handle: string | null; p2Handle: string | null },
): string {
  const { kind, reason } = outcome;
  switch (reason) {
    case "natural":
      return kind === "bot-won" ? "system bot won" : "natural win";
    case "time_forfeit": {
      const loser =
        kind === "win-p1"
          ? agents.p2Handle
          : kind === "win-p2"
            ? agents.p1Handle
            : kind === "bot-won"
              ? agents.p1Handle // human (p1) ran out
              : null;
      return loser ? `@${loser} ran out of time` : "ran out of time";
    }
    case "invalid_move_forfeit": {
      const loser =
        kind === "win-p1"
          ? agents.p2Handle
          : kind === "win-p2"
            ? agents.p1Handle
            : kind === "bot-won"
              ? agents.p1Handle
              : null;
      return loser
        ? `@${loser} forfeited on two illegal moves`
        : "forfeited on illegal moves";
    }
    case "resign": {
      const loser =
        kind === "win-p1"
          ? agents.p2Handle
          : kind === "win-p2"
            ? agents.p1Handle
            : kind === "bot-won"
              ? agents.p1Handle
              : null;
      return loser ? `@${loser} resigned` : "resigned";
    }
    case "draw":
      return "draw";
    case "abandoned":
      return "match abandoned";
    default:
      return reason ?? "match concluded";
  }
}
