/**
 * Sparkline — inline SVG line chart for tables and movers lists. Pure SSR,
 * no JS needed. Pass points, width, height, color.
 */
import { cn } from "@/lib/utils";

export interface SparklineProps {
  points: number[];
  width?: number;
  height?: number;
  /** CSS color value (var(--green-text), var(--ox-bright), etc). */
  stroke?: string;
  className?: string;
}

export function Sparkline({
  points,
  width = 60,
  height = 16,
  stroke = "var(--green-text)",
  className,
}: SparklineProps) {
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const d = points
    .map((p, i) => {
      const x = i * step;
      const y = height - ((p - min) / range) * (height - 2) - 1;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      className={cn("inline-block align-middle", className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
