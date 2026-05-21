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
 *
 * Optional context (moveCount) sharpens the narration so spectators
 * see "ran out of time on move 6" instead of just "ran out of time".
 * abandoned matches with moveCount=0 surface "no moves played"
 * explicitly so a refunded match doesn't read as "agent ghosted".
 */
export function describeOutcomeDetail(
  outcome: MatchOutcome,
  agents: { p1Handle: string | null; p2Handle: string | null },
  context: { moveCount?: number } = {},
): string {
  const { kind, reason } = outcome;
  const onMove = (n: number | undefined): string =>
    n != null && n >= 1 ? ` on move ${n}` : "";
  switch (reason) {
    case "natural":
      return kind === "bot-won"
        ? `system bot won${onMove(context.moveCount)}`
        : `natural win${onMove(context.moveCount)}`;
    case "time_forfeit": {
      const loser =
        kind === "win-p1"
          ? agents.p2Handle
          : kind === "win-p2"
            ? agents.p1Handle
            : kind === "bot-won"
              ? agents.p1Handle // human (p1) ran out
              : null;
      // moveCount on the match is the count of moves SUBMITTED before
      // the forfeit — the forfeit itself happened ON the next move.
      const nextMove = context.moveCount != null ? context.moveCount + 1 : undefined;
      return loser
        ? `@${loser} ran out of time${onMove(nextMove)}`
        : `ran out of time${onMove(nextMove)}`;
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
      const nextMove = context.moveCount != null ? context.moveCount + 1 : undefined;
      return loser
        ? `@${loser} forfeited on two illegal moves${onMove(nextMove)}`
        : `forfeited on illegal moves${onMove(nextMove)}`;
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
      return loser
        ? `@${loser} resigned${onMove(context.moveCount)}`
        : `resigned${onMove(context.moveCount)}`;
    }
    case "draw":
      return context.moveCount != null && context.moveCount > 0
        ? `draw after ${context.moveCount} moves`
        : "draw";
    case "abandoned":
      // moveCount=0 means the match was reaped before either side
      // played — spell that out so the spectator doesn't mistake
      // "abandoned" for "agent rage-quit mid-game".
      return context.moveCount === 0
        ? "no moves played · both sides refunded"
        : `match abandoned${onMove(context.moveCount)}`;
    default:
      return reason ?? "match concluded";
  }
}
