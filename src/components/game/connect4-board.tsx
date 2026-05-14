"use client";

import { cn } from "@/lib/utils";

/**
 * Connect4Board — renders a 6×7 grid as a stylized SVG.
 *
 * Conventions:
 *   - board[0] is the top row, board[5] the bottom.
 *   - cells: 0 empty, 1 player 1 (oxblood disc), 2 player 2 (gold disc).
 *   - `lastMove` (optional) highlights the most recently dropped piece.
 *   - `winLine` (optional) draws a luminous stroke through the winning four.
 *   - `onColumnClick` (optional) wires interactive piece-drop preview.
 *   - `liveLabel` (optional) is announced via an off-screen live region for
 *     screen reader users. Pass a description like "Agent Beta played column 3".
 *
 * Animation: when boardState changes, freshly-occupied cells transition with
 * a brief drop-in. We rely on CSS keyframes triggered by `key` on the disc.
 * Animation is suppressed under `prefers-reduced-motion: reduce` (see
 * globals.css).
 */

const ROWS = 6;
const COLS = 7;

type Board = number[][];

export interface Connect4BoardProps {
  board: Board;
  lastMove?: readonly [number, number] | null;
  winLine?: ReadonlyArray<readonly [number, number]> | null;
  onColumnClick?: (col: number) => void;
  className?: string;
  /** When true, columns highlight on hover and accept clicks. */
  interactive?: boolean;
  /** Screen-reader announcement for the most recent state change. */
  liveLabel?: string;
}

export function Connect4Board({
  board,
  lastMove,
  winLine,
  onColumnClick,
  className,
  interactive = false,
  liveLabel,
}: Connect4BoardProps) {
  // SVG geometry — keep it crisp at any size by using viewBox-based units.
  const CELL = 80;
  const PAD = 12;
  const W = COLS * CELL + 2 * PAD;
  const H = ROWS * CELL + 2 * PAD;

  return (
    <div className={cn("relative h-full w-full", className)}>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveLabel ?? ""}
      </span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-full w-full select-none"
        role="img"
        aria-label="Connect 4 board"
      >
      {/* Frame */}
      <defs>
        <linearGradient id="frame-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.22 0.015 30)" />
          <stop offset="100%" stopColor="oklch(0.14 0.012 20)" />
        </linearGradient>
        <radialGradient id="cell-shadow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="rgba(0,0,0,0.6)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </radialGradient>
        <filter id="disc-shadow">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.5" />
        </filter>
      </defs>

      <rect
        x={0}
        y={0}
        width={W}
        height={H}
        rx={14}
        fill="url(#frame-grad)"
        stroke="oklch(0.27 0.012 20)"
        strokeWidth={1.5}
      />

      {/* Column hit-targets (transparent overlays for hover/click) */}
      {interactive &&
        Array.from({ length: COLS }, (_, c) => (
          <rect
            key={`hit-${c}`}
            x={PAD + c * CELL}
            y={0}
            width={CELL}
            height={H}
            fill="transparent"
            className="cursor-pointer transition-colors hover:fill-white/[0.04]"
            onClick={() => onColumnClick?.(c)}
          />
        ))}

      {/* Cell holes */}
      {board.map((row, r) =>
        row.map((cell, c) => {
          const cx = PAD + c * CELL + CELL / 2;
          const cy = PAD + r * CELL + CELL / 2;
          const isLast = lastMove && lastMove[0] === r && lastMove[1] === c;
          return (
            <g key={`cell-${r}-${c}`}>
              {/* hole shadow */}
              <circle cx={cx} cy={cy} r={CELL * 0.4} fill="url(#cell-shadow)" />
              {/* disc */}
              {cell !== 0 && (
                <circle
                  key={`disc-${r}-${c}-${cell}`}
                  cx={cx}
                  cy={cy}
                  r={CELL * 0.36}
                  fill={cell === 1 ? "var(--coliseum-oxblood)" : "var(--coliseum-gold)"}
                  stroke={
                    cell === 1
                      ? "var(--coliseum-oxblood-bright)"
                      : "var(--coliseum-gold-dim)"
                  }
                  strokeWidth={2}
                  filter="url(#disc-shadow)"
                  style={{
                    animation: isLast ? "disc-drop 350ms cubic-bezier(.18,1,.45,1)" : undefined,
                    transformOrigin: `${cx}px ${cy}px`,
                  }}
                />
              )}
              {/* last-move marker */}
              {isLast && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={CELL * 0.44}
                  fill="none"
                  stroke={cell === 1 ? "var(--coliseum-oxblood-bright)" : "var(--coliseum-gold)"}
                  strokeWidth={2}
                  opacity={0.55}
                />
              )}
            </g>
          );
        }),
      )}

      {/* Win line */}
      {winLine && winLine.length >= 2 && (
        <polyline
          points={winLine
            .map(([r, c]) => `${PAD + c * CELL + CELL / 2},${PAD + r * CELL + CELL / 2}`)
            .join(" ")}
          fill="none"
          stroke="var(--coliseum-gold)"
          strokeWidth={5}
          strokeLinecap="round"
          opacity={0.85}
        />
      )}

        <style>{`
          @media (prefers-reduced-motion: no-preference) {
            @keyframes disc-drop {
              0%   { transform: translateY(-${ROWS * CELL}px); opacity: 0; }
              60%  { opacity: 1; }
              85%  { transform: translateY(6px); }
              100% { transform: translateY(0); opacity: 1; }
            }
          }
        `}</style>
      </svg>
    </div>
  );
}
