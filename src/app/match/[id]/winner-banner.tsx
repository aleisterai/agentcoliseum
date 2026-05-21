"use client";

/**
 * WinnerBanner — outcome strip rendered between the board panel header
 * and the board itself when status === "completed". Always tells the
 * spectator who won and why, with reason-specific copy so a forfeit
 * doesn't look like a draw.
 *
 * Outcome classification lives in `./outcome.ts` (pure, unit-tested)
 * so this component stays purely presentational. The five outcome
 * kinds we render:
 *
 *   - win-p1 / win-p2: one of the recorded agents won. Gold ribbon +
 *     trophy + handle + reason detail.
 *   - bot-won: system-mode match where the bot beat the human. NO
 *     fake "draw" label — clearly attribute the win to the system
 *     bot and the loss to the human.
 *   - draw: only when resultReason === "draw". Paid-mode draws show
 *     the refund note ($0 platform fee, full stake returned to each
 *     owner — Option A in the lifecycle docs).
 *   - abandoned: operator-close / refund path.
 *   - unknown: data inconsistency. Renders a neutral "match
 *     concluded" — log surface still tells the operator what's broken.
 */
import { classifyOutcome, describeOutcomeDetail } from "./outcome";
import { formatUsdcMicro } from "./utils";

export function WinnerBanner({
  winnerAgentId,
  resultReason,
  p1,
  p2,
  mode,
  stakeUsdc,
  moveCount,
}: {
  winnerAgentId: string | null;
  resultReason: string | null;
  p1: { id: string; handle: string; displayName: string } | null;
  p2: { id: string; handle: string; displayName: string } | null;
  mode: "free" | "paid" | "system";
  stakeUsdc: number | null;
  /** Number of moves actually submitted before the match ended. Threaded
   *  through so the banner can narrate "ran out of time on move 6"
   *  instead of a bare "ran out of time". */
  moveCount?: number;
}) {
  const outcome = classifyOutcome({
    mode,
    winnerAgentId,
    resultReason,
    p1Id: p1?.id ?? null,
    p2Id: p2?.id ?? null,
  });
  const detail = describeOutcomeDetail(
    outcome,
    {
      p1Handle: p1?.handle ?? null,
      p2Handle: p2?.handle ?? null,
    },
    { moveCount },
  );

  if (outcome.kind === "draw") {
    // For paid draws, settlement-sweep refunds each owner's full stake
    // (Option A — no platform fee on draws). Surface that explicitly so
    // an owner watching the match doesn't think they lost money.
    const showRefundNote = mode === "paid" && (stakeUsdc ?? 0) > 0;
    const stakeStr = showRefundNote ? formatUsdcMicro(stakeUsdc as number) : "";
    return (
      <div
        className="col"
        style={{
          padding: "10px 14px",
          margin: "0 12px",
          marginTop: 8,
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          background: "color-mix(in oklab, var(--text-mute) 8%, transparent)",
          gap: 4,
          alignItems: "center",
          fontSize: 12,
        }}
      >
        <div className="row" style={{ gap: 10 }}>
          <span
            className="mono"
            style={{ color: "var(--text-mute)", letterSpacing: 1 }}
          >
            — DRAW —
          </span>
          <span className="dim mono">·</span>
          <span className="mono" style={{ color: "var(--text-mute)" }}>
            {detail}
          </span>
        </div>
        {showRefundNote ? (
          <div
            className="row"
            style={{ gap: 6, fontSize: 11, color: "var(--text-mute)" }}
          >
            <span className="mono">stakes refunded · </span>
            <span className="money">{stakeStr} USDC</span>
            <span className="mono">to each side · no platform fee</span>
          </div>
        ) : null}
      </div>
    );
  }

  // System bot won — render a real loss banner attributing the win to
  // the bot and the action to the human (p1). Same chrome as a
  // recorded-agent win, just without an agent handle on the winner
  // side.
  if (outcome.kind === "bot-won") {
    return (
      <div
        className="row"
        style={{
          padding: "12px 16px",
          margin: "0 12px",
          marginTop: 8,
          borderRadius: 6,
          background:
            "linear-gradient(90deg, color-mix(in oklab, var(--gold) 14%, transparent), transparent)",
          borderLeft: "3px solid var(--gold)",
          gap: 10,
          alignItems: "center",
          fontSize: 13,
        }}
      >
        <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>
          🤖
        </span>
        <span
          className="mono"
          style={{ color: "var(--gold)", fontWeight: 600 }}
        >
          System bot
        </span>
        <span className="mono" style={{ color: "var(--text)" }}>
          won
        </span>
        <span className="dim mono">·</span>
        <span className="mono" style={{ color: "var(--text-mute)" }}>
          {detail}
        </span>
      </div>
    );
  }

  if (outcome.kind === "win-p1" || outcome.kind === "win-p2") {
    const winner = outcome.kind === "win-p1" ? p1 : p2;
    const winnerSide = outcome.kind === "win-p1" ? "red" : "gold";
    if (!winner) {
      // Defensive: classifier said a side won but we don't have the
      // corresponding agent row. Fall through to neutral banner.
      return <NeutralBanner detail={detail} />;
    }
    return (
      <div
        className="row"
        style={{
          padding: "12px 16px",
          margin: "0 12px",
          marginTop: 8,
          borderRadius: 6,
          background:
            "linear-gradient(90deg, color-mix(in oklab, var(--gold) 14%, transparent), transparent)",
          borderLeft: "3px solid var(--gold)",
          gap: 10,
          alignItems: "center",
          fontSize: 13,
        }}
      >
        <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>
          🏆
        </span>
        <span
          className="mono"
          style={{
            color: winnerSide === "red" ? "var(--red, #ef4444)" : "var(--gold)",
            fontWeight: 600,
          }}
        >
          @{winner.handle}
        </span>
        <span className="mono" style={{ color: "var(--text)" }}>
          won
        </span>
        <span className="dim mono">·</span>
        <span className="mono" style={{ color: "var(--text-mute)" }}>
          {detail}
        </span>
      </div>
    );
  }

  // abandoned / unknown — neutral
  return <NeutralBanner detail={detail} />;
}

function NeutralBanner({ detail }: { detail: string }) {
  return (
    <div
      className="row"
      style={{
        padding: "10px 14px",
        margin: "0 12px",
        marginTop: 8,
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        gap: 10,
        justifyContent: "center",
        fontSize: 12,
      }}
    >
      <span className="mono" style={{ color: "var(--text-mute)" }}>
        match concluded · {detail}
      </span>
    </div>
  );
}
