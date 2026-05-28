/**
 * GameBoard — gameType-aware board dispatcher.
 *
 * Routes to the right renderer (MiniBoard for Connect 4, TicTacToeBoard for
 * Tic-Tac-Toe, etc.) based on `gameType`. As each Wave lands a new adapter,
 * add a case here.
 *
 * Accepts an opaque `state` object (the boardgame.io G), pulls the field
 * each renderer needs, and forwards `lastMove`. Falls back to a placeholder
 * for game types that don't have a renderer yet.
 */
import { MiniBoard } from "./mini-board";
import { TicTacToeBoard } from "./tic-tac-toe-board";
import { ChessBoard } from "./chess-board";
import { CheckersBoard } from "./checkers-board";
import { ReversiBoard } from "./reversi-board";
import { GomokuBoard } from "./gomoku-board";
import { DotsAndBoxesBoard } from "./dots-and-boxes-board";
import { MancalaBoard } from "./mancala-board";
import { NineMensMorrisBoard } from "./nine-mens-morris-board";
import { NimBoard } from "./nim-board";
import { HexBoard } from "./hex-board";
import { QuoridorBoard } from "./quoridor-board";
import { SantoriniBoard } from "./santorini-board";
import { TakBoard } from "./tak-board";
import { YoteBoard } from "./yote-board";
import { LiarsDiceBoard } from "./liars-dice-board";

export interface GameBoardProps {
  gameType: string;
  state?: unknown;
  /**
   * Last-move marker. The shape depends on the game:
   *   - connect4: `[row, col]` (the landed cell)
   *   - tic-tac-toe: a single flat index 0..8
   */
  lastMove?: unknown;
  className?: string;
}

export function GameBoard({ gameType, state, lastMove, className }: GameBoardProps) {
  if (gameType === "connect4") {
    const board = (state as { board?: number[][] } | undefined)?.board ?? null;
    const lm = (lastMove ?? null) as readonly [number, number] | null;
    return <MiniBoard board={board} lastMove={lm} className={className} />;
  }
  if (gameType === "tic-tac-toe") {
    const board = (state as { board?: number[] } | undefined)?.board ?? null;
    const lm = typeof lastMove === "number" ? lastMove : null;
    return <TicTacToeBoard board={board} lastMove={lm} className={className} />;
  }
  if (gameType === "chess") {
    const board = (state as { board?: string[] } | undefined)?.board ?? null;
    const lm =
      lastMove && typeof lastMove === "object" &&
      "from" in lastMove && "to" in lastMove
        ? (lastMove as { from: number; to: number })
        : null;
    return <ChessBoard board={board} lastMove={lm} className={className} />;
  }
  if (gameType === "checkers") {
    const board = (state as { board?: string[] } | undefined)?.board ?? null;
    const lm =
      lastMove && typeof lastMove === "object" &&
      "from" in lastMove && "to" in lastMove
        ? (lastMove as { from: [number, number]; to: [number, number] })
        : null;
    return <CheckersBoard board={board} lastMove={lm} className={className} />;
  }
  if (gameType === "reversi") {
    const board = (state as { board?: string[] } | undefined)?.board ?? null;
    const lm =
      lastMove && typeof lastMove === "object" &&
      "row" in lastMove && "col" in lastMove
        ? (lastMove as { row: number; col: number })
        : null;
    return <ReversiBoard board={board} lastMove={lm} className={className} />;
  }
  if (gameType === "gomoku") {
    const board = (state as { board?: string[] } | undefined)?.board ?? null;
    const lm =
      lastMove && typeof lastMove === "object" &&
      "row" in lastMove && "col" in lastMove
        ? (lastMove as { row: number; col: number })
        : null;
    return <GomokuBoard board={board} lastMove={lm} className={className} />;
  }
  if (gameType === "dots-and-boxes") {
    const s = state as { hEdges?: boolean[]; vEdges?: boolean[]; boxes?: Array<"" | "0" | "1"> } | undefined;
    const lm =
      lastMove && typeof lastMove === "object" &&
      "type" in lastMove && "row" in lastMove && "col" in lastMove
        ? (lastMove as { type: "h" | "v"; row: number; col: number })
        : null;
    return (
      <DotsAndBoxesBoard
        hEdges={s?.hEdges ?? null}
        vEdges={s?.vEdges ?? null}
        boxes={s?.boxes ?? null}
        lastMove={lm}
        className={className}
      />
    );
  }
  if (gameType === "mancala") {
    const pits = (state as { pits?: number[] } | undefined)?.pits ?? null;
    const lm =
      lastMove && typeof lastMove === "object" &&
      "pit" in lastMove && "landed" in lastMove
        ? (lastMove as { pit: number; landed: number })
        : null;
    return <MancalaBoard pits={pits} lastMove={lm} className={className} />;
  }
  if (gameType === "nine-mens-morris") {
    const points = (state as { points?: Array<"" | "0" | "1"> } | undefined)?.points ?? null;
    const lm =
      lastMove && typeof lastMove === "object" &&
      "to" in lastMove
        ? (lastMove as { from: number | null; to: number })
        : null;
    return <NineMensMorrisBoard points={points} lastMove={lm} className={className} />;
  }
  if (gameType === "nim") {
    const piles = (state as { piles?: number[] } | undefined)?.piles ?? null;
    const lm =
      lastMove && typeof lastMove === "object" &&
      "pile" in lastMove && "take" in lastMove
        ? (lastMove as { pile: number; take: number })
        : null;
    return <NimBoard piles={piles} lastMove={lm} className={className} />;
  }
  if (gameType === "hex") {
    const board = (state as { board?: string[] } | undefined)?.board ?? null;
    const lm =
      lastMove && typeof lastMove === "object" &&
      "row" in lastMove && "col" in lastMove
        ? (lastMove as { row: number; col: number })
        : null;
    return <HexBoard board={board} lastMove={lm} className={className} />;
  }
  if (gameType === "quoridor") {
    const s = state as
      | {
          pawns?: { "0": { row: number; col: number }; "1": { row: number; col: number } };
          hWalls?: boolean[];
          vWalls?: boolean[];
        }
      | undefined;
    const lm =
      lastMove && typeof lastMove === "object" && "kind" in lastMove
        ? (lastMove as {
            kind: "pawn" | "wall";
            to?: { row: number; col: number };
            wall?: { type: "h" | "v"; row: number; col: number };
          })
        : null;
    return (
      <QuoridorBoard
        pawns={s?.pawns ?? null}
        hWalls={s?.hWalls ?? null}
        vWalls={s?.vWalls ?? null}
        lastMove={lm}
        className={className}
      />
    );
  }
  if (gameType === "santorini") {
    const s = state as
      | {
          levels?: number[];
          builders?: {
            "0": [{ row: number; col: number }, { row: number; col: number }];
            "1": [{ row: number; col: number }, { row: number; col: number }];
          };
        }
      | undefined;
    return (
      <SantoriniBoard
        levels={s?.levels ?? null}
        builders={s?.builders ?? null}
        className={className}
      />
    );
  }
  if (gameType === "tak") {
    const s = state as
      | { cells?: Array<{ side: "0" | "1"; kind: "F" | "W" } | null> }
      | undefined;
    const lm =
      lastMove && typeof lastMove === "object" && "to" in lastMove && "kind" in lastMove
        ? (lastMove as { to: { row: number; col: number }; kind: "F" | "W" })
        : null;
    return <TakBoard cells={s?.cells ?? null} lastMove={lm} className={className} />;
  }
  if (gameType === "yote") {
    const board = (state as { board?: Array<"" | "0" | "1"> } | undefined)?.board ?? null;
    const lm =
      lastMove && typeof lastMove === "object" && "to" in lastMove
        ? (lastMove as { kind: string; to?: number })
        : null;
    return <YoteBoard board={board} lastMove={lm} className={className} />;
  }
  if (gameType === "liars-dice") {
    const s = state as
      | {
          diceCount?: { "0": number; "1": number };
          bid?: { quantity: number; face: number } | null;
          bidder?: string | null;
          lastChallenge?: never;
        }
      | undefined;
    return <LiarsDiceBoard state={s ?? null} className={className} />;
  }
  return (
    <div
      className={className}
      style={{
        aspectRatio: "1 / 1",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-mute)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        border: "1px solid var(--line)",
        borderRadius: 4,
        background: "var(--bg-1)",
      }}
    >
      no renderer for {gameType}
    </div>
  );
}
