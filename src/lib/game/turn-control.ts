/**
 * Shared helper for games with an "extra turn" rule.
 *
 * Mancala (bonus turn when last seed lands in own store), dots-and-boxes
 * (closing a box gives another turn), and reversi (auto-pass when the
 * opponent has no legal moves) all face the same boardgame.io quirk:
 * by default `turn: { maxMoves: 1 }` advances ctx.currentPlayer after
 * every move, but these games want G.turn to drive who moves next.
 *
 * Each adapter used to inline the pattern (~10 lines × 3 games = three
 * opportunities for the next person to miss the events.endTurn() line).
 *
 * Now:
 *
 *   turn: { minMoves: 1 },          // never maxMoves: 1
 *   moves: {
 *     someName: extraTurnAware<G, Arg>((G, playerID, raw) => {
 *       // ... validate + mutate G ...
 *       // return INVALID_MOVE to reject, void to accept
 *     }),
 *   },
 *
 * For games where G.turn isn't the literal playerID (reversi maps
 * "0"→"B", "1"→"W"), pass a custom `isCurrentPlayer` predicate. The
 * helper calls it twice: once at entry (was it my turn?) and once after
 * the inner ran (did the move keep my turn?). If the second call returns
 * false, we advance the boardgame.io turn via events.endTurn().
 *
 * @see src/lib/game/games/mancala/game.ts (bonus turn on store)
 * @see src/lib/game/games/dots-and-boxes/game.ts (extra turn on box close)
 * @see src/lib/game/games/reversi/game.ts (auto-pass when opponent stuck)
 */
import { INVALID_MOVE } from "boardgame.io/core";

interface MoveContext<TG> {
  G: TG;
  playerID: string | undefined;
  events: { endTurn: () => void };
}

export interface ExtraTurnOptions<TG> {
  /**
   * Returns true if `playerID` is the current G-turn-holder. Default
   * compares `G.turn === playerID` — fine for mancala/dots-and-boxes
   * where G.turn is "0" | "1". Reversi overrides this because G.turn is
   * "B" | "W".
   */
  isCurrentPlayer?: (G: TG, playerID: string) => boolean;
}

function defaultIsCurrentPlayer<TG>(G: TG, playerID: string): boolean {
  return (G as { turn?: string })?.turn === playerID;
}

/**
 * Wraps a boardgame.io move with the extra-turn pattern. Inner fn
 * focuses purely on validation + state mutation; the wrapper handles
 * the entry turn-check and the conditional `events.endTurn()`.
 *
 * @returns INVALID_MOVE if it isn't `playerID`'s turn, if the inner fn
 *   returned INVALID_MOVE, or if `playerID` is undefined. Otherwise
 *   void — boardgame.io accepts the move.
 */
export function extraTurnAware<TG, TArg>(
  fn: (G: TG, playerID: string, raw: TArg) => typeof INVALID_MOVE | void,
  opts: ExtraTurnOptions<TG> = {},
) {
  const isCurrent = opts.isCurrentPlayer ?? defaultIsCurrentPlayer<TG>;
  return ({ G, playerID, events }: MoveContext<TG>, raw: TArg) => {
    if (playerID == null) return INVALID_MOVE;
    if (!isCurrent(G, playerID)) return INVALID_MOVE;
    const result = fn(G, playerID, raw);
    if (result === INVALID_MOVE) return INVALID_MOVE;
    // Did the move keep the turn on the same player? If not, advance
    // boardgame.io's ctx.currentPlayer so it agrees with G.turn.
    if (!isCurrent(G, playerID)) events.endTurn();
    return undefined;
  };
}
