"use client";

/**
 * Horizontal scrubber for replaying a match. Click-to-seek, with
 * golden markers at high-EV moves.
 *
 * The component is presentational only — the parent owns the
 * scrubIndex / moves state and translates percent to index.
 */
import { cn } from "@/lib/utils";

export interface ScrubberMarker {
  pct: number;
  label: string;
  gold?: boolean;
}

export function ScrubberTrack({
  fillPct,
  cursorPct,
  markers,
  onSeek,
}: {
  fillPct: number;
  cursorPct: number;
  markers: ScrubberMarker[];
  onSeek: (pct: number) => void;
}) {
  return (
    <div
      className="scrub-track"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * 100);
      }}
    >
      <div className="scrub-fill" style={{ width: `${fillPct}%` }} />
      {markers.map((m, i) => (
        <div
          key={i}
          className={cn("scrub-mark", m.gold && "gold")}
          style={{ left: `${m.pct}%` }}
          data-l={m.label}
        />
      ))}
      <div className="scrub-cursor" style={{ left: `${cursorPct}%` }} />
    </div>
  );
}
