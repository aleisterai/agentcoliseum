/**
 * IsometricColiseum — the hero "fig.01" graphic, ported 1:1 from the
 * claude.ai/design handoff bundle (2026-05-15, ruKmf6dd…).
 *
 * Visual layout:
 *
 *   ┌── .coliseum-frame (square, hairline border) ──────────────────┐
 *   │  • .coliseum-grid    faint blueprint grid (radial-masked CSS) │
 *   │  • .coliseum-rings   2 concentric perspective rings (CSS)     │
 *   │  • .coliseum-stage   ↓ this is the SVG ↓                      │
 *   │      4-tier isometric arena, sand floor + sigil, 4 banner     │
 *   │      pylons on the outer rim                                  │
 *   │  • .coliseum-corners 4 calibration-crosshair ticks            │
 *   │  • .coliseum-badges  4 floating mono labels (TL/TR/BL/BR)     │
 *   │  • .coliseum-caption "fig.01 — the agent coliseum"            │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Animation:
 *   - The whole stage SVG slowly rotates in-plane (~60s per turn) so
 *     the piece reads as a turntable view — keeps the isometric
 *     perspective intact (vs. rotateY which would distort it).
 *   - `.arena-glow` (the inner sigil ring) pulses on a 3.4s loop.
 *   - Dashed sigil halo counter-rotates faster (~24s) for layered
 *     motion.
 *   - All CSS animations — no JS, no rAF, no canvas. Server-renderable.
 *
 * Sized to fill `.hero-coliseum` exactly. The badges in the corners
 * are absolute-positioned over the frame and stay still while the
 * SVG rotates underneath, matching the design's "calibration
 * instrument" framing.
 */

import { catalogEntry } from "@/lib/game/catalog";

interface Tier {
  rx: number;
  ry: number;
  h: number;
  cols: number;
}

const VIEW_W = 600;
const VIEW_H = 400;
const CX = 300;
const CY = 240;

const TIERS: Tier[] = [
  { rx: 270, ry: 92, h: 56, cols: 64 },
  { rx: 234, ry: 80, h: 42, cols: 52 },
  { rx: 196, ry: 66, h: 30, cols: 40 },
  { rx: 158, ry: 52, h: 18, cols: 30 },
];

/** Cumulative-top: tier 0 sits on the ground (baseY = cy), tier 1
 *  sits on top of tier 0 (baseY = cy - tier0.h), etc. */
function buildTierData() {
  let cumTop = 0;
  return TIERS.map((t) => {
    const baseY = CY - cumTop;
    const topY = baseY - t.h;
    cumTop += t.h;
    return { ...t, baseY, topY };
  });
}

/** Front-facing wall path between an outer ellipse (at baseY) and the
 *  same ellipse offset up by `h` (at topY). The arcs run along the
 *  visible HALF of each ellipse so the wall reads as a curved facade
 *  rather than a flat panel. */
function wallPath(rx: number, ry: number, baseY: number, topY: number): string {
  return [
    `M ${CX - rx},${baseY}`,
    `A ${rx},${ry} 0 0 0 ${CX + rx},${baseY}`,
    `L ${CX + rx},${topY}`,
    `A ${rx},${ry} 0 0 1 ${CX - rx},${topY}`,
    `Z`,
  ].join(" ");
}

/** Column ticks (vertical seating-arch lines) evenly distributed along
 *  the front arc of the wall. We sweep theta from π → 2π so ticks
 *  only land on the front (visible) half of each ellipse. */
function columnTicks(
  rx: number,
  ry: number,
  baseY: number,
  topY: number,
  cols: number,
): string {
  const ticks: string[] = [];
  for (let i = 1; i < cols; i++) {
    const t = Math.PI + (i / cols) * Math.PI;
    const x = CX + rx * Math.cos(t);
    const y = baseY + ry * Math.sin(t);
    ticks.push(
      `M ${x.toFixed(2)},${y.toFixed(2)} L ${x.toFixed(2)},${topY.toFixed(2)}`,
    );
  }
  return ticks.join(" ");
}

/** Front arc of the top ellipse — the highlighted "rim" of the tier
 *  where the seating step crests. */
function topRim(rx: number, ry: number, topY: number): string {
  return `M ${CX - rx},${topY} A ${rx},${ry} 0 0 0 ${CX + rx},${topY}`;
}

/** Back arc of the top ellipse — peeks behind the front wall to add
 *  depth. */
function backRim(rx: number, ry: number, topY: number): string {
  return `M ${CX - rx},${topY} A ${rx},${ry} 0 0 1 ${CX + rx},${topY}`;
}

export interface IsometricColiseumProps {
  /** Optional override for the bottom-right "sigil" badge — gold by
   *  default, used to indicate the platform's struck sigil. */
  sigilLabel?: string;
  /** Optional override for the top-right status — defaults to "open".
   *  Pass "live" + an integer matchCount to render a live indicator. */
  status?: { label: string; live?: boolean };
  /** Optional override for the BL tier-count text. */
  capacity?: string;
}

export function IsometricColiseum({
  sigilLabel = "◆ struck",
  status = { label: "open" },
  capacity = "cap · 80,000",
}: IsometricColiseumProps) {
  const tiers = buildTierData();
  const innermost = tiers[tiers.length - 1];
  const outer = tiers[0];

  const arenaRx = innermost.rx - 22;
  const arenaRy = innermost.ry - 8;
  const arenaCy = innermost.topY;

  // Sand-floor parallel lines — horizontal slices clipped to the
  // arena ellipse so they read as a stadium-floor stripe pattern.
  const sandLines: Array<{ x1: number; x2: number; y: number }> = [];
  for (let i = -3; i <= 3; i++) {
    const fy = arenaCy + i * 8;
    const dx = Math.sqrt(Math.max(0, 1 - ((i * 8) / arenaRy) ** 2)) * arenaRx;
    if (dx > 0) sandLines.push({ x1: CX - dx, x2: CX + dx, y: fy });
  }

  // Sigil — small triangle-in-circle at the arena center.
  const sigilSize = 18;

  // 4 banner pylons on the outer top rim at hand-picked angles so
  // they sit on the visible front quadrants of the rim.
  const pylonAngles = [Math.PI * 1.1, Math.PI * 1.35, Math.PI * 1.65, Math.PI * 1.9];

  return (
    <div className="coliseum-frame" aria-hidden="true">
      <div className="coliseum-grid" />
      <div className="coliseum-rings" />
      <div className="coliseum-stage">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="xMidYMid meet"
          aria-label="Agent Coliseum — isometric arena"
        >
          <defs>
            <radialGradient id="sandGrad" cx="50%" cy="50%" r="50%">
              <stop
                offset="0%"
                stopColor="color-mix(in oklab, var(--gold) 22%, var(--bg))"
              />
              <stop
                offset="100%"
                stopColor="color-mix(in oklab, var(--ox) 16%, var(--bg))"
              />
            </radialGradient>
            <radialGradient id="glowGrad" cx="50%" cy="50%" r="50%">
              <stop
                offset="0%"
                stopColor="color-mix(in oklab, var(--gold) 35%, transparent)"
              />
              <stop offset="100%" stopColor="transparent" />
            </radialGradient>
          </defs>

          {/* Crosshair guides — faint dashed centerlines */}
          <line
            x1="0"
            y1={CY}
            x2={VIEW_W}
            y2={CY}
            stroke="color-mix(in oklab, var(--line) 60%, transparent)"
            strokeWidth="0.6"
            strokeDasharray="2 4"
          />
          <line
            x1={CX}
            y1="0"
            x2={CX}
            y2={VIEW_H}
            stroke="color-mix(in oklab, var(--line) 60%, transparent)"
            strokeWidth="0.6"
            strokeDasharray="2 4"
          />

          {/* This <g> rotates slowly via CSS — keeps the perspective
              intact while giving the piece a turntable feel. */}
          <g className="coliseum-rotor">
            {tiers.map((t, i) => {
              const stroke = `color-mix(in oklab, var(--ox) ${30 + i * 10}%, var(--line-3, var(--line)))`;
              const fill =
                i === 0
                  ? "color-mix(in oklab, var(--bg-2) 90%, var(--ox))"
                  : `color-mix(in oklab, var(--ox) ${14 + (i - 1) * 8}%, var(--bg-2))`;
              const topFill =
                i === 0
                  ? "color-mix(in oklab, var(--bg-3) 80%, var(--ox))"
                  : `color-mix(in oklab, var(--ox) ${22 + (i - 1) * 10}%, var(--bg-3))`;
              return (
                <g key={i} className="tier" data-i={i}>
                  {/* back rim peeks behind the front wall */}
                  <path
                    d={backRim(t.rx, t.ry, t.topY)}
                    stroke="color-mix(in oklab, var(--text) 30%, transparent)"
                    strokeWidth="0.7"
                    fill="none"
                  />
                  {/* the seating ring's floor (top step) */}
                  <ellipse
                    cx={CX}
                    cy={t.topY}
                    rx={t.rx}
                    ry={t.ry}
                    fill={topFill}
                    stroke={stroke}
                    strokeWidth="0.7"
                  />
                  {/* front-facing wall */}
                  <path
                    d={wallPath(t.rx, t.ry, t.baseY, t.topY)}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth="0.9"
                  />
                  {/* column ticks (seating arches) */}
                  <path
                    d={columnTicks(t.rx, t.ry, t.baseY, t.topY, t.cols)}
                    stroke="color-mix(in oklab, var(--text) 18%, transparent)"
                    strokeWidth="0.6"
                    fill="none"
                  />
                  {/* front-edge highlight */}
                  <path
                    d={topRim(t.rx, t.ry, t.topY)}
                    stroke="color-mix(in oklab, var(--text) 70%, transparent)"
                    strokeWidth="0.8"
                    fill="none"
                  />
                </g>
              );
            })}

            {/* Arena floor (sand) on top of the innermost tier */}
            <ellipse
              cx={CX}
              cy={arenaCy}
              rx={arenaRx + 14}
              ry={arenaRy + 6}
              fill="url(#glowGrad)"
            />
            <ellipse
              cx={CX}
              cy={arenaCy}
              rx={arenaRx}
              ry={arenaRy}
              fill="url(#sandGrad)"
              stroke="color-mix(in oklab, var(--gold) 45%, var(--line))"
              strokeWidth="0.8"
            />
            <g
              stroke="color-mix(in oklab, var(--ox) 30%, transparent)"
              strokeWidth="0.5"
            >
              {sandLines.map((l, i) => (
                <line key={i} x1={l.x1} y1={l.y} x2={l.x2} y2={l.y} />
              ))}
            </g>

            {/* Central sigil — small triangle-in-circle with a
                glowing dashed halo. The halo counter-rotates via CSS. */}
            <g className="arena-glow" transform={`translate(${CX} ${arenaCy})`}>
              <circle
                className="sigil-halo"
                r={sigilSize + 6}
                fill="none"
                stroke="color-mix(in oklab, var(--gold) 55%, transparent)"
                strokeWidth="0.6"
                strokeDasharray="2 3"
              />
              <circle
                r={sigilSize}
                fill="color-mix(in oklab, var(--gold) 14%, transparent)"
                stroke="color-mix(in oklab, var(--gold) 70%, transparent)"
                strokeWidth="1"
              />
              <path
                d={`M 0,${-sigilSize * 0.55} L ${sigilSize * 0.5},${sigilSize * 0.32} L ${-sigilSize * 0.5},${sigilSize * 0.32} Z`}
                fill="color-mix(in oklab, var(--gold) 30%, transparent)"
                stroke="var(--gold)"
                strokeWidth="1"
              />
              <circle r="2.4" cy="2" fill="var(--gold)" />
            </g>

            {/* Banner pylons on the outer top rim. The two interior
                pylons are gold; the two exterior are oxblood, for the
                cross-axis brand contrast. */}
            {pylonAngles.map((a, k) => {
              const x = CX + outer.rx * Math.cos(a);
              const y = outer.topY + outer.ry * Math.sin(a);
              const isGold = k === 1 || k === 2;
              return (
                <g
                  key={k}
                  className="pylon"
                  transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
                >
                  <line
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="-18"
                    stroke="color-mix(in oklab, var(--text) 60%, transparent)"
                    strokeWidth="0.7"
                  />
                  <path
                    d="M 0,-18 L 7,-15 L 0,-12 Z"
                    fill={isGold ? "var(--gold)" : "var(--ox-bright)"}
                    opacity="0.9"
                  />
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Calibration crosshair corner ticks */}
      <div className="coliseum-corners">
        <span /><span /><span /><span />
      </div>

      {/* Floating badges with mono labels — calibration-instrument feel */}
      <div className="coliseum-badges">
        <div className="cb cb-tl">
          <span className="cb-k">N · 41.8902</span>
          <span className="cb-v">E · 12.4922</span>
        </div>
        <div className="cb cb-tr">
          <span className="cb-k">arena · alpha</span>
          <span className="cb-v">
            {status.live ? (
              <>
                <span
                  className="pulse-dot"
                  style={{
                    display: "inline-block",
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--ox-bright)",
                    marginRight: 5,
                    verticalAlign: "middle",
                  }}
                />
                {status.label}
              </>
            ) : (
              status.label
            )}
          </span>
        </div>
        <div className="cb cb-bl">
          <span className="cb-k">tiers · 4</span>
          <span className="cb-v">{capacity}</span>
        </div>
        <div className="cb cb-br">
          <span className="cb-k">sigil</span>
          <span className="cb-v gold">{sigilLabel}</span>
        </div>
      </div>

      <div className="coliseum-caption">
        <span className="dim">fig.01 —</span> the agent coliseum
      </div>
    </div>
  );
}

// Keep the import alive — once we wire per-game stats into the
// badges (live tier count from the active matches, etc.) this lookup
// will populate the bottom-right pylon labels. Removing it now would
// just re-add it next sprint.
void catalogEntry;
