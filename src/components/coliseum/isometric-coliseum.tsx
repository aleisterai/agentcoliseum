"use client";

/**
 * IsometricColiseum — the hero "fig.01" graphic, ported 1:1 from the
 * claude.ai/design handoff bundle (2026-05-15, ruKmf6dd…) WITH
 * proper 3D rotation around the building's vertical axis.
 *
 * Why this is a client component:
 *   The arena is a cylindrical building viewed from a fixed isometric
 *   camera. Rotating a static 2D SVG via `transform: rotateY` flattens
 *   it — it looks like paper turning, not a building spinning. The
 *   actual 3D rotation effect comes from MARCHING the column ticks
 *   around the cylinder's perimeter while the tier ellipse silhouettes
 *   stay constant (they're invariant under Y-axis rotation in
 *   isometric projection — a cylinder's outline from above is always
 *   the same ellipse no matter how it's spun).
 *
 *   So every frame:
 *     - Tier walls / cornices / arena floor / sigil: STATIC (cached)
 *     - Column ticks: recomputed at the current rotation angle θ;
 *       only those on the FRONT half of the cylinder (sin(φ+θ) > 0)
 *       are drawn; their y-position foreshortens correctly toward
 *       the silhouette edges
 *     - Banner pylons: 4 fixed building-coordinates rotate around; ones
 *       on the back hide, ones on the front are gold/ox alternating
 *
 *   Net effect: spectator sees a true 3D coliseum spinning on its
 *   vertical axis, with columns marching across the front and
 *   disappearing into the back like a real rotating cylindrical
 *   structure.
 *
 * Frame structure (matches the design):
 *   ┌── coliseum-frame (square hairline border) ──────────────────┐
 *   │  blueprint grid (faint, radial-masked CSS)                  │
 *   │  2 concentric perspective rings (oxblood + gold)             │
 *   │  ── SVG stage ──                                             │
 *   │  • 4-tier isometric arena (silhouette static)                │
 *   │  • COLUMN TICKS animated per-frame                           │
 *   │  • gold sand floor with sigil (sigil halo counter-rotates)   │
 *   │  • 4 banner pylons orbit visible front quadrant              │
 *   │  4 corner calibration ticks                                  │
 *   │  4 floating mono badges                                      │
 *   │  "fig.01 — the agent coliseum" caption                       │
 *   └─────────────────────────────────────────────────────────────┘
 */

import { useEffect, useRef } from "react";

interface TierSpec {
  rx: number;
  ry: number;
  h: number;
  cols: number;
}

interface TierData extends TierSpec {
  baseY: number;
  topY: number;
}

interface BannerData {
  ref: React.RefObject<SVGGElement | null>;
  /** Building-frame angle (where on the cylinder the pylon sits). */
  angle: number;
  /** Gold (true) or ox-bright (false). */
  isGold: boolean;
}

const VIEW_W = 600;
const VIEW_H = 400;
const CX = 300;
const CY = 240;

const TIERS: TierSpec[] = [
  { rx: 270, ry: 92, h: 56, cols: 64 },
  { rx: 234, ry: 80, h: 42, cols: 52 },
  { rx: 196, ry: 66, h: 30, cols: 40 },
  { rx: 158, ry: 52, h: 18, cols: 30 },
];

function buildTierData(): TierData[] {
  let cumTop = 0;
  return TIERS.map((t) => {
    const baseY = CY - cumTop;
    const topY = baseY - t.h;
    cumTop += t.h;
    return { ...t, baseY, topY };
  });
}

/** Static front-wall path between an outer ellipse (at baseY) and the
 *  top ellipse (at topY). Invariant under Y-axis rotation because the
 *  cylinder's silhouette is the ellipse itself. */
function wallPath(rx: number, ry: number, baseY: number, topY: number): string {
  return [
    `M ${CX - rx},${baseY}`,
    `A ${rx},${ry} 0 0 0 ${CX + rx},${baseY}`,
    `L ${CX + rx},${topY}`,
    `A ${rx},${ry} 0 0 1 ${CX - rx},${topY}`,
    `Z`,
  ].join(" ");
}

function topRim(rx: number, ry: number, topY: number): string {
  return `M ${CX - rx},${topY} A ${rx},${ry} 0 0 0 ${CX + rx},${topY}`;
}

function backRim(rx: number, ry: number, topY: number): string {
  return `M ${CX - rx},${topY} A ${rx},${ry} 0 0 1 ${CX + rx},${topY}`;
}

/**
 * Compute the visible column ticks for one tier at rotation angle θ.
 * For each column k of cols total, its building-frame angle is
 * φ = (k / cols) * 2π. Projected to screen at rotation θ:
 *   x = cx + rx * cos(φ + θ)
 *   y = baseY + ry * sin(φ + θ)
 * Only columns on the FRONT half (sin(φ + θ) > 0) are drawn — the
 * back half is occluded by the wall.
 *
 * This is the per-frame work. The output is a single SVG path `d`
 * string that the rAF tick assigns to the tier's tick `<path>`.
 */
function columnTicksAtAngle(t: TierData, theta: number): string {
  const ticks: string[] = [];
  for (let k = 0; k < t.cols; k++) {
    const phi = (k / t.cols) * Math.PI * 2;
    const a = phi + theta;
    const s = Math.sin(a);
    // s > 0 = front half (positive y in screen coords means down,
    // which for a top-down isometric ellipse means the front-facing
    // arc). Hide back-half columns.
    if (s <= 0) continue;
    const c = Math.cos(a);
    const x = CX + t.rx * c;
    const y = t.baseY + t.ry * s;
    ticks.push(`M ${x.toFixed(2)},${y.toFixed(2)} L ${x.toFixed(2)},${t.topY.toFixed(2)}`);
  }
  return ticks.join(" ");
}

export interface IsometricColiseumProps {
  sigilLabel?: string;
  status?: { label: string; live?: boolean };
  capacity?: string;
  /** Rotation period in seconds. Set null to freeze. */
  rotationPeriodSec?: number | null;
}

export function IsometricColiseum({
  sigilLabel = "◆ struck",
  status = { label: "open" },
  capacity = "cap · 80,000",
  rotationPeriodSec = 24,
}: IsometricColiseumProps) {
  const tiers = buildTierData();
  const innermost = tiers[tiers.length - 1];
  const outer = tiers[0];

  const arenaRx = innermost.rx - 22;
  const arenaRy = innermost.ry - 8;
  const arenaCy = innermost.topY;

  const sigilSize = 18;

  // Refs for the per-frame DOM updates. One `<path>` per tier holds
  // ALL of that tier's visible column ticks (joined into one path
  // string for cheap updates), and one `<g>` per banner pylon for
  // its transform. Declared at top level (not inside arrays) so the
  // hook order is unambiguous to React's reconciler.
  const tick0 = useRef<SVGPathElement | null>(null);
  const tick1 = useRef<SVGPathElement | null>(null);
  const tick2 = useRef<SVGPathElement | null>(null);
  const tick3 = useRef<SVGPathElement | null>(null);
  const tickRefs = [tick0, tick1, tick2, tick3];

  const ban0 = useRef<SVGGElement | null>(null);
  const ban1 = useRef<SVGGElement | null>(null);
  const ban2 = useRef<SVGGElement | null>(null);
  const ban3 = useRef<SVGGElement | null>(null);
  const banners: BannerData[] = [
    { ref: ban0, angle: 0, isGold: false },
    { ref: ban1, angle: Math.PI / 2, isGold: true },
    { ref: ban2, angle: Math.PI, isGold: true },
    { ref: ban3, angle: (3 * Math.PI) / 2, isGold: false },
  ];

  useEffect(() => {
    if (!rotationPeriodSec || rotationPeriodSec <= 0) return;

    const startedAt = performance.now();
    let frameId = 0;
    let visible = !document.hidden;

    function tick(now: number) {
      const elapsed = (now - startedAt) / 1000;
      const theta = (elapsed / rotationPeriodSec!) * Math.PI * 2;

      // Tier column ticks
      for (let i = 0; i < tiers.length; i++) {
        const ref = tickRefs[i].current;
        if (!ref) continue;
        ref.setAttribute("d", columnTicksAtAngle(tiers[i], theta));
      }

      // Banner pylons — each fixed at a building-frame angle, projected
      // to screen at theta. Hide ones on the back half (sin < 0).
      for (const b of banners) {
        const el = b.ref.current;
        if (!el) continue;
        const a = b.angle + theta;
        const s = Math.sin(a);
        if (s <= 0) {
          el.setAttribute("opacity", "0");
          continue;
        }
        const c = Math.cos(a);
        const x = CX + outer.rx * c;
        const y = outer.topY + outer.ry * s;
        // Fade slightly at the silhouette edges where the pylon is
        // almost edge-on — looks more natural than a hard cut.
        const opacity = Math.min(1, s * 1.4).toFixed(2);
        el.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        el.setAttribute("opacity", opacity);
      }

      if (visible) frameId = requestAnimationFrame(tick);
    }

    function onVisibility() {
      visible = !document.hidden;
      if (visible) frameId = requestAnimationFrame(tick);
      else cancelAnimationFrame(frameId);
    }

    frameId = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // tiers/banners arrays are stable across renders (constructed from
    // module-level constants inside the component); refs persist;
    // rotationPeriodSec is the only dependency that should trigger
    // restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotationPeriodSec]);

  // Sand-floor parallel lines, clipped to the arena ellipse.
  const sandLines: Array<{ x1: number; x2: number; y: number }> = [];
  for (let i = -3; i <= 3; i++) {
    const fy = arenaCy + i * 8;
    const dx = Math.sqrt(Math.max(0, 1 - ((i * 8) / arenaRy) ** 2)) * arenaRx;
    if (dx > 0) sandLines.push({ x1: CX - dx, x2: CX + dx, y: fy });
  }

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

          {/* Crosshair guides */}
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

          {/* Static tier silhouettes — invariant under Y-rotation. */}
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
                {/* back rim (drawn behind front wall) */}
                <path
                  d={backRim(t.rx, t.ry, t.topY)}
                  stroke="color-mix(in oklab, var(--text) 30%, transparent)"
                  strokeWidth="0.7"
                  fill="none"
                />
                {/* top step (the seating ring floor) */}
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
                {/* ANIMATED column ticks — d attribute updated per
                    frame. Initial d is empty; rAF tick fills it in. */}
                <path
                  ref={tickRefs[i]}
                  d=""
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

          {/* Arena floor + sigil — static (the floor doesn't rotate
              visually since it's circular). */}
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

          {/* Banner pylons — ANIMATED. Each is a <g> with rAF tick
              updating its transform + opacity for the orbit + back-half
              occlusion. */}
          {banners.map((b, k) => (
            <g key={k} ref={b.ref} className="pylon">
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
                fill={b.isGold ? "var(--gold)" : "var(--ox-bright)"}
                opacity="0.9"
              />
            </g>
          ))}
        </svg>
      </div>

      <div className="coliseum-corners">
        <span /><span /><span /><span />
      </div>

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
