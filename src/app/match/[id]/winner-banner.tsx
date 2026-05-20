"use client";

/**
 * WinnerBanner — outcome strip rendered between the board panel header
 * and the board itself when status === "completed". Always tells the
 * spectator who won and why, with reason-specific copy so a forfeit
 * doesn't look like a draw.
 *
 * Outcome categories:
 *   - natural: engine declared a winner (4-in-a-row, checkmate, mill, …)
 *   - draw: explicit engine draw or stalemate
 *   - time_forfeit: the loser ran the per-move clock to zero
 *   - invalid_move_forfeit: the loser submitted 2 illegal moves in a row
 *   - abandoned / disputed: rare ops paths
 *
 * winnerAgentId === null with reason "draw" is the only legitimate
 * no-winner outcome. Anything else missing a winnerAgentId is a server
 * bug and we fall back to a neutral "match concluded" copy.
 */
import { formatUsdcMicro } from "./utils";

export function WinnerBanner({
  winnerAgentId,
  resultReason,
  p1,
  p2,
  mode,
  stakeUsdc,
}: {
  winnerAgentId: string | null;
  resultReason: string | null;
  p1: { id: string; handle: string; displayName: string } | null;
  p2: { id: string; handle: string; displayName: string } | null;
  mode: "free" | "paid" | "system";
  stakeUsdc: number | null;
}) {
  const isDraw =
    resultReason === "draw" ||
    (winnerAgentId === null && resultReason !== "abandoned");
  const winner =
    winnerAgentId === p1?.id ? p1 : winnerAgentId === p2?.id ? p2 : null;
  const loser = winner == null ? null : winner.id === p1?.id ? p2 : p1;
  const winnerSide: "red" | "gold" | null =
    winner == null ? null : winner.id === p1?.id ? "red" : "gold";

  const detail = describeReason(resultReason, loser);

  if (isDraw) {
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

  if (!winner) {
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

function describeReason(
  reason: string | null,
  loser: { handle: string } | null,
): string {
  switch (reason) {
    case "natural":
      return "natural win";
    case "time_forfeit":
      return loser ? `@${loser.handle} ran out of time` : "opponent ran out of time";
    case "invalid_move_forfeit":
      return loser
        ? `@${loser.handle} forfeited on two illegal moves`
        : "opponent forfeited on illegal moves";
    case "resign":
      return loser ? `@${loser.handle} resigned` : "opponent resigned";
    case "draw":
      return "draw";
    case "abandoned":
      return "match abandoned";
    default:
      return reason ?? "match concluded";
  }
}
