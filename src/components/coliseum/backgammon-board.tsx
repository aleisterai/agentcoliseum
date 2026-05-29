/**
 * BackgammonBoard — perfect-info renderer.
 *
 * Two rows of 12 points (top = 23→12, bottom = 0→11) split by a bar lane,
 * mirroring a real board's two halves. Each point shows its stack: player 0
 * is the light checker, player 1 the oxblood one (classic white-vs-red,
 * using design tokens — never the money gold). The header shows the dice and
 * the bar/off tallies.
 */
import { cn } from "@/lib/utils";

export interface BackgammonBoardProps {
  state?: {
    points?: number[];
    bar?: { "0": number; "1": number };
    off?: { "0": number; "1": number };
    rolled?: [number, number] | null;
    dice?: number[];
    turn?: string;
  } | null;
  className?: string;
}

const P0 = "var(--text-1)"; // light checkers
const P1 = "var(--ox-bright)"; // red checkers

function Stack({ signed }: { signed: number }) {
  const n = Math.abs(signed);
  const color = signed > 0 ? P0 : P1;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minHeight: 18 }}>
      {n === 0 ? (
        <span style={{ width: 14, height: 14 }} />
      ) : (
        <>
          {Array.from({ length: Math.min(n, 5) }).map((_, i) => (
            <span
              key={i}
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: color,
                boxShadow: "inset 0 0 0 1px var(--line)",
              }}
            />
          ))}
          {n > 5 ? (
            <span className="mono" style={{ fontSize: 9, color }}>
              {n}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

function PointCell({ idx, signed }: { idx: number; signed: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: 0 }}>
      <Stack signed={signed} />
      <span className="mono" style={{ fontSize: 8.5, color: "var(--text-mute)", marginTop: 2 }}>
        {idx}
      </span>
    </div>
  );
}

const PIPS = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

export function BackgammonBoard({ state, className }: BackgammonBoardProps) {
  const pts = state?.points ?? new Array<number>(24).fill(0);
  const bar = state?.bar ?? { "0": 0, "1": 0 };
  const off = state?.off ?? { "0": 0, "1": 0 };
  const rolled = state?.rolled ?? null;

  const topRow: number[] = [];
  for (let i = 23; i >= 12; i--) topRow.push(i);
  const bottomRow: number[] = [];
  for (let i = 0; i <= 11; i++) bottomRow.push(i);

  return (
    <div
      className={cn(className)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        background: "var(--bg-1)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        width: "100%",
      }}
    >
      {/* Header: dice + bar/off */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-mute)" }}>
            Roll
          </span>
          <span style={{ fontSize: 20, color: "var(--text-1)" }}>
            {rolled ? `${PIPS[rolled[0]] ?? rolled[0]} ${PIPS[rolled[1]] ?? rolled[1]}` : "—"}
          </span>
        </div>
        <div className="mono" style={{ fontSize: 11, display: "flex", gap: 14, color: "var(--text-2)" }}>
          <span>
            bar <span style={{ color: P0 }}>{bar["0"]}</span>/<span style={{ color: P1 }}>{bar["1"]}</span>
          </span>
          <span>
            off <span style={{ color: P0 }}>{off["0"]}</span>/<span style={{ color: P1 }}>{off["1"]}</span>
          </span>
        </div>
      </div>

      {/* Top row 23→12 */}
      <div style={{ display: "flex", gap: 2 }}>
        {topRow.map((i) => (
          <PointCell key={i} idx={i} signed={pts[i] ?? 0} />
        ))}
      </div>
      <div style={{ borderTop: "1px dashed var(--line)" }} />
      {/* Bottom row 0→11 */}
      <div style={{ display: "flex", gap: 2 }}>
        {bottomRow.map((i) => (
          <PointCell key={i} idx={i} signed={pts[i] ?? 0} />
        ))}
      </div>

      <div className="mono" style={{ fontSize: 10, color: "var(--text-mute)", display: "flex", gap: 14, justifyContent: "center" }}>
        <span>
          <span style={{ color: P0 }}>●</span> P0 → 0
        </span>
        <span>
          <span style={{ color: P1 }}>●</span> P1 → 23
        </span>
      </div>
    </div>
  );
}
