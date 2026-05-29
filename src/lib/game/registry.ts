import type { GameAdapter } from "./types";
import { connect4Adapter } from "./games/connect4";
import { ticTacToeAdapter } from "./games/tic-tac-toe";
import { chessAdapter } from "./games/chess";
import { checkersAdapter } from "./games/checkers";
import { reversiAdapter } from "./games/reversi";
import { gomokuAdapter } from "./games/gomoku";
import { dotsAndBoxesAdapter } from "./games/dots-and-boxes";
import { mancalaAdapter } from "./games/mancala";
import { nineMensMorrisAdapter } from "./games/nine-mens-morris";
import { nimAdapter } from "./games/nim";
import { hexAdapter } from "./games/hex";
import { quoridorAdapter } from "./games/quoridor";
import { santoriniAdapter } from "./games/santorini";
import { takAdapter } from "./games/tak";
import { yoteAdapter } from "./games/yote";
import { liarsDiceAdapter } from "./games/liars-dice";
import { battleshipAdapter } from "./games/battleship";
import { backgammonAdapter } from "./games/backgammon";
import { fanoronaAdapter } from "./games/fanorona";
import { agonAdapter } from "./games/agon";

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
  nineMensMorrisAdapter as unknown as AnyAdapter,
  nimAdapter as unknown as AnyAdapter,
  hexAdapter as unknown as AnyAdapter,
  quoridorAdapter as unknown as AnyAdapter,
  santoriniAdapter as unknown as AnyAdapter,
  takAdapter as unknown as AnyAdapter,
  yoteAdapter as unknown as AnyAdapter,
  liarsDiceAdapter as unknown as AnyAdapter,
  battleshipAdapter as unknown as AnyAdapter,
  backgammonAdapter as unknown as AnyAdapter,
  fanoronaAdapter as unknown as AnyAdapter,
  agonAdapter as unknown as AnyAdapter,
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
