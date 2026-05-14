"use client";

import { useEffect, useRef } from "react";
import { Pause, Play, Rewind, FastForward, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SPEEDS = [1, 2, 4, 8, 16] as const;
export type ReplaySpeed = (typeof SPEEDS)[number];

export interface ReplayControlsProps {
  moveCount: number;
  currentIndex: number;
  setCurrentIndex: (i: number) => void;
  isPlaying: boolean;
  setIsPlaying: (b: boolean) => void;
  speed: ReplaySpeed;
  setSpeed: (s: ReplaySpeed) => void;
  liveMode: boolean;
  setLiveMode: (b: boolean) => void;
}

export function ReplayControls(p: ReplayControlsProps) {
  // Keyboard shortcuts: space pause/play, ← → step.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        p.setIsPlaying(!p.isPlaying);
      } else if (e.code === "ArrowLeft") {
        p.setCurrentIndex(Math.max(0, p.currentIndex - 1));
      } else if (e.code === "ArrowRight") {
        p.setCurrentIndex(Math.min(p.moveCount - 1, p.currentIndex + 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  // Drag-to-seek (range input).
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => p.setCurrentIndex(Math.max(0, p.currentIndex - 1))}
          aria-label="step back"
        >
          <Rewind className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => p.setIsPlaying(!p.isPlaying)}
          aria-label={p.isPlaying ? "pause" : "play"}
        >
          {p.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => p.setCurrentIndex(Math.min(p.moveCount - 1, p.currentIndex + 1))}
          aria-label="step forward"
        >
          <FastForward className="h-4 w-4" />
        </Button>

        <input
          ref={inputRef}
          type="range"
          min={0}
          max={Math.max(0, p.moveCount - 1)}
          value={p.currentIndex}
          onChange={(e) => {
            p.setCurrentIndex(Number(e.target.value));
            p.setLiveMode(false);
          }}
          className="flex-1 accent-primary"
          aria-label="Seek to move"
          aria-valuetext={
            p.moveCount === 0
              ? "No moves yet"
              : `Move ${p.currentIndex + 1} of ${p.moveCount}`
          }
        />

        <span className="font-numeric text-xs text-muted-foreground">
          {p.moveCount === 0 ? "0/0" : `${p.currentIndex + 1}/${p.moveCount}`}
        </span>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => p.setSpeed(s)}
              className={cn(
                "rounded px-2 py-0.5 font-numeric text-xs uppercase tracking-wider transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                p.speed === s
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary",
              )}
              aria-pressed={p.speed === s}
              aria-label={`Playback speed ${s}×`}
            >
              {s}×
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => p.setLiveMode(!p.liveMode)}
          className={cn(
            "inline-flex items-center gap-2 rounded px-2 py-0.5 font-numeric text-xs uppercase tracking-wider transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            p.liveMode
              ? "bg-destructive/15 text-destructive"
              : "text-muted-foreground hover:bg-secondary",
          )}
          aria-pressed={p.liveMode}
          aria-label={p.liveMode ? "Following live; click to pause" : "Click to follow live"}
        >
          <Radio className="h-3 w-3" />
          {p.liveMode ? "live" : "follow live"}
        </button>
      </div>
    </div>
  );
}

export { SPEEDS };
