/**
 * BattleshipBoard — imperfect-info renderer for Battleship.
 *
 * The public state hides both fleets, so this shared spectator board shows
 * only what everyone is allowed to see: the two PUBLIC shot grids (every
 * hit and miss). A player's own fleet arrives via `privateState` on the
 * match API and isn't rendered here. During placement there are no shots
 * yet, so we show a placement status line instead.
 */
import { cn } from "@/lib/utils";

type Shot = "" | "hit" | "miss";

export interface BattleshipBoardProps {
  state?: {
    phase?: "placement" | "firing";
    placed?: { "0": boolean; "1": boolean };
    turn?: string;
    shots?: { "0"?: Shot[]; "1"?: Shot[] };
    lastShot?: { by: string; index: number; result: "hit" | "miss"; sunk: string | null } | null;
  } | null;
  className?: string;
}

const BOARD = 10;

function ShotGrid({ shots, label }: { shots: Shot[]; label: string }) {
  const hits = shots.filter((s) => s === "hit").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--text-mute)",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{label}</span>
        <span style={{ color: hits > 0 ? "var(--ox-bright)" : "var(--text-mute)" }}>
          {hits} hit{hits === 1 ? "" : "s"}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${BOARD}, 1fr)`,
          gap: 2,
          aspectRatio: "1 / 1",
        }}
      >
        {Array.from({ length: BOARD * BOARD }).map((_, i) => {
          const v = shots[i] ?? "";
          const bg =
            v === "hit"
              ? "var(--ox-bright)"
              : v === "miss"
                ? "var(--bg-2)"
                : "var(--bg-1)";
          return (
            <span
              key={i}
              style={{
                background: bg,
                borderRadius: 2,
                boxShadow: "inset 0 0 0 1px var(--line)",
                aspectRatio: "1 / 1",
                position: "relative",
              }}
            >
              {v === "miss" ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    margin: "auto",
                    width: 3,
                    height: 3,
                    borderRadius: "50%",
                    background: "var(--text-mute)",
                  }}
                />
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function BattleshipBoard({ state, className }: BattleshipBoardProps) {
  const phase = state?.phase ?? "placement";
  const shots0 = state?.shots?.["0"] ?? [];
  const shots1 = state?.shots?.["1"] ?? [];
  const lastShot = state?.lastShot ?? null;

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
      <div style={{ textAlign: "center" }}>
        <div
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--text-mute)",
          }}
        >
          {phase === "placement" ? "Fleets deploying" : "Salvo exchange"}
        </div>
        {lastShot ? (
          <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2 }}>
            P{lastShot.by} fired →{" "}
            <span style={{ color: lastShot.result === "hit" ? "var(--ox-bright)" : "var(--text-mute)" }}>
              {lastShot.result}
            </span>
            {lastShot.sunk ? ` · sank ${lastShot.sunk}` : ""}
          </div>
        ) : null}
      </div>

      {phase === "placement" ? (
        <div
          style={{
            textAlign: "center",
            padding: "24px 0",
            color: "var(--text-mute)",
            fontSize: 13,
          }}
        >
          Ships hidden until the first salvo.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 16 }}>
          <ShotGrid shots={shots0} label="P0 → P1" />
          <ShotGrid shots={shots1} label="P1 → P0" />
        </div>
      )}
    </div>
  );
}
