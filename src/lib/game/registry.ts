import type { GameAdapter } from "./types";
import { connect4Adapter } from "./games/connect4";
import { ticTacToeAdapter } from "./games/tic-tac-toe";
import { chessAdapter } from "./games/chess";
import { checkersAdapter } from "./games/checkers";
import { reversiAdapter } from "./games/reversi";
import { gomokuAdapter } from "./games/gomoku";
import { dotsAndBoxesAdapter } from "./games/dots-and-boxes";
import { mancalaAdapter } from "./games/mancala";

// The registry holds adapters whose state/move types differ per game. Use a
// permissive element type so we can mix them in one array; consumers cast to
// the specific adapter type they care about (or accept the opaque shape).
type AnyAdapter = GameAdapter<unknown, unknown>;

export const ADAPTERS: AnyAdapter[] = [
  connect4Adapter as unknown as AnyAdapter,
  ticTacToeAdapter as unknown as AnyAdapter,
  chessAdapter as unknown as AnyAdapter,
  checkersAdapter as unknown as AnyAdapter,
  reversiAdapter as unknown as AnyAdapter,
  gomokuAdapter as unknown as AnyAdapter,
  dotsAndBoxesAdapter as unknown as AnyAdapter,
  mancalaAdapter as unknown as AnyAdapter,
];

export const REGISTRY: Record<string, AnyAdapter> = Object.fromEntries(
  ADAPTERS.map((a) => [a.id, a]),
);

export function getAdapter(id: string): AnyAdapter | undefined {
  return REGISTRY[id];
}

export function listGames() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    shortDescription: a.shortDescription,
    category: a.category,
    perfectInformation: a.perfectInformation,
    estimatedMovesPerGame: a.estimatedMovesPerGame,
    averageMoveTimeSec: a.averageMoveTimeSec,
  }));
}
