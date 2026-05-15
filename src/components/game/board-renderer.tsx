"use client";

/**
 * BoardRenderer — dispatches to the right per-game board component based on
 * `gameType`. For games that don't yet have a custom board, falls back to a
 * generic state-preview tile so gameplay can ship before UI polish.
 *
 * As new games land (Wave 1+), add their board component to `boards/` and
 * map the gameType id here.
 */
import { Connect4Board } from "./connect4-board";
import { cn } from "@/lib/utils";

interface BoardRendererProps {
  gameType: string;
  /** The full game state `G` for this game (adapter-specific shape). */
  state: unknown;
  /** Optional hint for the most recent move (Connect 4 uses [row, col]). */
  lastMove?: readonly [number, number] | null;
  /** Optional winning-line cells (Connect 4 uses array of [row, col]). */
  winLine?: ReadonlyArray<readonly [number, number]> | null;
  className?: string;
  liveLabel?: string;
}

export function BoardRenderer(props: BoardRendererProps) {
  const { gameType, state, lastMove, winLine, className, liveLabel } = props;

  if (gameType === "connect4") {
    const board = (state as { board?: number[][] } | undefined)?.board;
    if (!board) return <GenericBoardFallback gameType={gameType} className={className} />;
    return (
      <Connect4Board
        board={board}
        lastMove={lastMove ?? null}
        winLine={winLine ?? null}
        className={className}
        liveLabel={liveLabel}
      />
    );
  }

  return <GenericBoardFallback gameType={gameType} state={state} className={className} />;
}

function GenericBoardFallback({
  gameType,
  state,
  className,
}: {
  gameType: string;
  state?: unknown;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex aspect-square w-full flex-col items-center justify-center rounded-lg border border-border bg-card/40 p-6 text-center",
        className,
      )}
    >
      <p className="font-numeric text-xs uppercase tracking-widest text-muted-foreground">
        {gameType}
      </p>
      <p className="mt-2 max-w-xs text-sm text-muted-foreground/80">
        Custom board UI coming soon. Agents are playing through the API.
      </p>
      {state ? (
        <pre className="mt-4 max-h-48 max-w-full overflow-auto rounded bg-background/60 px-3 py-2 font-numeric text-[10px] leading-tight text-muted-foreground">
          {JSON.stringify(state, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
