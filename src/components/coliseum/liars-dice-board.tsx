/**
 * LiarsDiceBoard — imperfect-info renderer for Liar's Dice.
 *
 * The public state hides both cups, so the board shows what spectators are
 * allowed to see: each player's dice COUNT (face-down dice), the standing
 * bid, and — when a challenge just resolved — the revealed dice + outcome.
 * A player's own dice arrive via `privateState` on the match API and aren't
 * rendered here (this is the shared spectator board).
 */
import { cn } from "@/lib/utils";

const PIPS = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"]; // ⚀..⚅ at 1..6

interface Bid {
  quantity: number;
  face: number;
}
interface ChallengeRecord {
  bidWasTrue: boolean;
  loser: string;
  actualCount: number;
  bid: Bid;
  revealed: { "0": number[]; "1": number[] };
}

export interface LiarsDiceBoardProps {
  state?: {
    diceCount?: { "0": number; "1": number };
    bid?: Bid | null;
    bidder?: string | null;
    lastChallenge?: ChallengeRecord | null;
  } | null;
  className?: string;
}

function FaceDownRow({ n, color }: { n: number; color: string }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {Array.from({ length: Math.max(0, n) }).map((_, i) => (
        <span
          key={i}
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            background: "var(--bg-2)",
            boxShadow: `inset 0 0 0 1.5px ${color}`,
            display: "inline-block",
          }}
        />
      ))}
      {n === 0 ? (
        <span className="mono" style={{ fontSize: 11, color: "var(--text-mute)" }}>
          out
        </span>
      ) : null}
    </div>
  );
}

export function LiarsDiceBoard({ state, className }: LiarsDiceBoardProps) {
  const diceCount = state?.diceCount ?? { "0": 5, "1": 5 };
  const bid = state?.bid ?? null;
  const lc = state?.lastChallenge ?? null;

  return (
    <div
      className={cn(className)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 14,
        background: "var(--bg-1)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        width: "100%",
      }}
    >
      {/* Standing bid */}
      <div style={{ textAlign: "center" }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-mute)" }}>
          Standing bid
        </div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 700, color: "var(--gold)" }}>
          {bid ? `${bid.quantity} × ${PIPS[bid.face] ?? bid.face}` : "—"}
        </div>
      </div>

      {/* Cups */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--ox-bright)" }}>P0</span>
          <FaceDownRow n={diceCount["0"]} color="var(--ox-bright)" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--gold)" }}>P1</span>
          <FaceDownRow n={diceCount["1"]} color="var(--gold)" />
        </div>
      </div>

      {/* Last challenge reveal */}
      {lc ? (
        <div style={{ borderTop: "1px dashed var(--line)", paddingTop: 8, fontSize: 12, color: "var(--text-2)" }}>
          <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-mute)" }}>
            Last challenge · bid {lc.bid.quantity} × {PIPS[lc.bid.face] ?? lc.bid.face} → {lc.actualCount} actual ·{" "}
            {lc.bidWasTrue ? "stood" : "busted"}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
            {(["0", "1"] as const).map((p) => (
              <div key={p} className="mono" style={{ fontSize: 14 }}>
                <span style={{ color: p === "0" ? "var(--ox-bright)" : "var(--gold)" }}>P{p}:</span>{" "}
                {(lc.revealed[p] ?? []).map((d) => PIPS[d] ?? d).join(" ") || "—"}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
