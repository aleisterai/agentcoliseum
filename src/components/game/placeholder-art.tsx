/**
 * PlaceholderArt — deterministic per-game SVG used as the card art for any
 * game that doesn't have a custom thumbnail. Each id hashes to a stable hue
 * and motif so the catalog looks intentional rather than uniformly bland.
 *
 * Motif catalogue:
 *   grid      → 3×3 to 9×9 cell pattern (for board-based games)
 *   hex       → packed hexagons (Hex)
 *   dice      → a single die face
 *   dots      → scattered field of dots (Dots & Boxes)
 *   ship      → silhouette aimed at the right edge (Battleship)
 *   tower     → stacked rectangles (Santorini, Tak)
 *   crescent  → curved arc (Fanorona, Yoté)
 *   monogram  → big two-letter mark (default)
 */
import { cn } from "@/lib/utils";

type Motif = "grid" | "hex" | "dice" | "dots" | "ship" | "tower" | "crescent" | "monogram";

const MOTIFS: Record<string, Motif> = {
  connect4: "grid",
  "tic-tac-toe": "grid",
  chess: "grid",
  checkers: "grid",
  reversi: "grid",
  gomoku: "grid",
  "dots-and-boxes": "dots",
  mancala: "crescent",
  "nine-mens-morris": "grid",
  nim: "dots",
  hex: "hex",
  quoridor: "grid",
  santorini: "tower",
  tak: "tower",
  backgammon: "dice",
  battleship: "ship",
  "liars-dice": "dice",
  fanorona: "crescent",
  yote: "crescent",
  agon: "hex",
};

// Brand-aligned palette: pairs are (primary, accent) where primary is the
// dominant motif color, accent is the highlight.
const PALETTE: Array<{ primary: string; accent: string; bg: string }> = [
  { primary: "oklch(0.55 0.21 22)", accent: "oklch(0.74 0.13 75)", bg: "oklch(0.13 0.018 22)" },   // oxblood + gold
  { primary: "oklch(0.74 0.13 75)", accent: "oklch(0.55 0.21 22)", bg: "oklch(0.15 0.014 75)" },   // gold + oxblood
  { primary: "oklch(0.60 0.14 165)", accent: "oklch(0.74 0.13 75)", bg: "oklch(0.13 0.020 165)" }, // teal + gold
  { primary: "oklch(0.55 0.16 260)", accent: "oklch(0.55 0.21 22)", bg: "oklch(0.13 0.020 260)" }, // indigo + oxblood
  { primary: "oklch(0.68 0.12 320)", accent: "oklch(0.74 0.13 75)", bg: "oklch(0.13 0.020 320)" }, // magenta + gold
  { primary: "oklch(0.74 0.13 75)", accent: "oklch(0.60 0.14 165)", bg: "oklch(0.13 0.012 22)" },  // gold + teal
];

function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function palette(id: string) {
  return PALETTE[hash(id) % PALETTE.length];
}

function motifFor(id: string): Motif {
  return MOTIFS[id] ?? "monogram";
}

export function PlaceholderArt({
  id,
  label,
  className,
}: {
  id: string;
  /** Optional override for the monogram label. Defaults to first 2 letters of id. */
  label?: string;
  className?: string;
}) {
  const colors = palette(id);
  const motif = motifFor(id);
  const monogram = (label ?? id).replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "AC";

  return (
    <div
      className={cn("relative overflow-hidden", className)}
      style={{ background: colors.bg, aspectRatio: "7 / 6" }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 140 120" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full">
        <MotifLayer motif={motif} primary={colors.primary} accent={colors.accent} seed={hash(id)} />
        {/* Compact monogram tucked into the bottom-left so the motif breathes. */}
        <text
          x="12"
          y="108"
          textAnchor="start"
          fontSize="22"
          fontWeight={700}
          letterSpacing="-0.5"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          fill={colors.accent}
          opacity={0.85}
          style={{ paintOrder: "stroke" }}
          stroke={colors.bg}
          strokeWidth={4}
        >
          {monogram}
        </text>
      </svg>
      {/* gradient fade so the bottom (where the title/footer sit) is calmer */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3"
        style={{ background: `linear-gradient(to top, ${colors.bg} 0%, transparent 100%)` }}
      />
    </div>
  );
}

function MotifLayer({
  motif,
  primary,
  accent,
  seed,
}: {
  motif: Motif;
  primary: string;
  accent: string;
  seed: number;
}) {
  switch (motif) {
    case "grid":
      return <GridMotif primary={primary} accent={accent} seed={seed} />;
    case "hex":
      return <HexMotif primary={primary} accent={accent} />;
    case "dice":
      return <DiceMotif primary={primary} accent={accent} />;
    case "dots":
      return <DotsMotif primary={primary} accent={accent} seed={seed} />;
    case "ship":
      return <ShipMotif primary={primary} accent={accent} />;
    case "tower":
      return <TowerMotif primary={primary} accent={accent} />;
    case "crescent":
      return <CrescentMotif primary={primary} accent={accent} />;
    case "monogram":
    default:
      return null;
  }
}

function GridMotif({ primary, accent, seed }: { primary: string; accent: string; seed: number }) {
  const N = 6;
  const cell = 16;
  const offsetX = 22;
  const offsetY = 12;
  const cells: React.ReactElement[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const filled = ((seed >>> (r * 3 + c)) & 1) === 1;
      cells.push(
        <rect
          key={`${r}-${c}`}
          x={offsetX + c * cell}
          y={offsetY + r * cell}
          width={cell - 2}
          height={cell - 2}
          rx={2}
          fill={filled ? accent : primary}
          opacity={filled ? 0.35 : 0.12}
        />,
      );
    }
  }
  return <g>{cells}</g>;
}

function HexMotif({ primary, accent }: { primary: string; accent: string }) {
  // Pointy-top hex tiling, sparse, alternating fills.
  const hexes: React.ReactElement[] = [];
  const s = 11; // side length
  const w = Math.sqrt(3) * s;
  const h = 2 * s * 0.75;
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 8; c++) {
      const cx = c * w + (r % 2 ? w / 2 : 0) + 6;
      const cy = r * h * 0.95 + 8;
      const filled = (r + c) % 3 === 0;
      hexes.push(
        <polygon
          key={`${r}-${c}`}
          points={[
            [cx, cy - s],
            [cx + w / 2, cy - s / 2],
            [cx + w / 2, cy + s / 2],
            [cx, cy + s],
            [cx - w / 2, cy + s / 2],
            [cx - w / 2, cy - s / 2],
          ]
            .map((p) => p.join(","))
            .join(" ")}
          fill={filled ? accent : primary}
          opacity={filled ? 0.32 : 0.1}
        />,
      );
    }
  }
  return <g>{hexes}</g>;
}

function DiceMotif({ primary, accent }: { primary: string; accent: string }) {
  // A single oversized die face in the bottom-right, with pips.
  return (
    <g>
      <rect x="62" y="28" width="64" height="64" rx="10" fill={primary} opacity={0.25} />
      {[
        [78, 44],
        [110, 44],
        [78, 76],
        [110, 76],
        [94, 60],
      ].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={5.5} fill={accent} opacity={0.85} />
      ))}
    </g>
  );
}

function DotsMotif({ primary, accent, seed }: { primary: string; accent: string; seed: number }) {
  const dots: React.ReactElement[] = [];
  const rows = 5;
  const cols = 7;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = 18 + c * 16;
      const y = 18 + r * 18;
      const filled = ((seed >>> (r * cols + c)) & 1) === 1;
      dots.push(
        <circle
          key={`${r}-${c}`}
          cx={x}
          cy={y}
          r={filled ? 3.5 : 2}
          fill={filled ? accent : primary}
          opacity={filled ? 0.7 : 0.25}
        />,
      );
    }
  }
  return <g>{dots}</g>;
}

function ShipMotif({ primary, accent }: { primary: string; accent: string }) {
  return (
    <g>
      {/* sea grid */}
      {[18, 36, 54, 72, 90, 108].map((y) => (
        <line key={y} x1={6} y1={y} x2={134} y2={y} stroke={primary} strokeOpacity={0.12} strokeWidth={1} />
      ))}
      {/* ship silhouette */}
      <polygon points="20,72 100,72 110,86 14,86" fill={primary} opacity={0.55} />
      <rect x="56" y="58" width="22" height="14" rx="2" fill={primary} opacity={0.7} />
      <rect x="62" y="50" width="10" height="10" rx="1" fill={accent} opacity={0.85} />
      {/* missile arc */}
      <path d="M120,30 Q90,10 50,40" fill="none" stroke={accent} strokeWidth={1.5} strokeOpacity={0.6} strokeDasharray="4 3" />
      <circle cx={50} cy={40} r={3} fill={accent} />
    </g>
  );
}

function TowerMotif({ primary, accent }: { primary: string; accent: string }) {
  // Three stacked rectangles narrowing upward, with a dome cap.
  return (
    <g>
      <rect x={48} y={92} width={50} height={14} rx={2} fill={primary} opacity={0.4} />
      <rect x={56} y={74} width={34} height={18} rx={2} fill={primary} opacity={0.55} />
      <rect x={62} y={58} width={22} height={16} rx={2} fill={accent} opacity={0.75} />
      <circle cx={73} cy={52} r={8} fill={accent} opacity={0.9} />
    </g>
  );
}

function CrescentMotif({ primary, accent }: { primary: string; accent: string }) {
  return (
    <g>
      <path d="M30,100 A60,60 0 0 1 130,40" fill="none" stroke={primary} strokeWidth={5} strokeOpacity={0.5} />
      <path d="M40,98 A60,60 0 0 1 122,52" fill="none" stroke={accent} strokeWidth={2.5} strokeOpacity={0.7} />
      {[20, 40, 60, 80, 100].map((pct, i) => {
        // dot along the outer arc
        const t = pct / 100;
        const cx = 30 + (130 - 30) * t;
        const cy = 100 - 60 * Math.sin(t * Math.PI);
        return <circle key={i} cx={cx} cy={cy} r={2.4} fill={accent} opacity={0.85} />;
      })}
    </g>
  );
}
