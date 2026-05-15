/**
 * Thin headless wrapper around boardgame.io.
 *
 * boardgame.io ships a client + server transport, but we don't need that —
 * we already own the HTTP layer, DB persistence, and Realtime broadcast.
 * We only want the framework for two things: applying a move to a state
 * deterministically, and detecting game-over.
 *
 * Internals used:
 *   InitializeGame  — initial { G, ctx, ... } from a Game definition
 *   CreateGameReducer — Redux-style reducer that handles MAKE_MOVE actions
 *
 * Both live under `boardgame.io/internal`, which is a stable export of the
 * framework's internals intended for tooling (testing harness, ai, server).
 */
import {
  CreateGameReducer,
  InitializeGame,
  ProcessGameConfig,
} from "boardgame.io/internal";
import type { Game, State } from "boardgame.io";

/**
 * Wrap a Game definition with cached reducer + processed config. Reuse the
 * same instance across requests; the wrapper is pure aside from the cache.
 */
export interface Engine<TState = unknown> {
  /** Build the initial { G, ctx, ... } state. */
  initialState(): State<TState>;
  /** Apply a move. Returns the next state, or null if the move was invalid. */
  applyMove(
    state: State<TState>,
    playerID: "0" | "1",
    moveName: string,
    args: unknown[],
  ): State<TState> | null;
  /** Game-over check: returns the boardgame.io gameover object, or null. */
  gameOver(state: State<TState>): GameOverInfo | null;
}

export interface GameOverInfo {
  /** boardgame.io's convention: '0' / '1' (player IDs) for winner, or { draw: true }. */
  winnerPlayerID: "0" | "1" | null;
  isDraw: boolean;
}

const cache = new WeakMap<Game<unknown>, Engine<unknown>>();

export function buildEngine<TState>(game: Game<TState>): Engine<TState> {
  const hit = cache.get(game as unknown as Game<unknown>);
  if (hit) return hit as Engine<TState>;

  const processed = ProcessGameConfig(game as Game) as Game;
  const reducer = CreateGameReducer({ game: processed });

  const engine: Engine<TState> = {
    initialState(): State<TState> {
      return InitializeGame({ game: processed }) as State<TState>;
    },

    applyMove(state, playerID, moveName, args) {
      const action = {
        type: "MAKE_MOVE" as const,
        payload: { type: moveName, args, playerID },
      };
      // The reducer accepts a "TransientState" but State is structurally
      // compatible — the transients field is optional and tracks errors.
      const next = reducer(state as unknown as Parameters<typeof reducer>[0], action);
      // If the move was rejected, boardgame.io attaches a transient with
      // a `transientId` for the error. State stays at the previous value.
      const transients = (next as unknown as { transients?: unknown }).transients;
      if (transients) return null;
      // Strip transients on the way out.
      const { transients: _t, ...rest } = next as unknown as Record<string, unknown>;
      return rest as unknown as State<TState>;
    },

    gameOver(state) {
      const over = state.ctx?.gameover;
      if (!over) return null;
      if (typeof over === "object" && "winner" in over) {
        const w = (over as { winner: string }).winner;
        return {
          winnerPlayerID: w === "0" || w === "1" ? (w as "0" | "1") : null,
          isDraw: false,
        };
      }
      if (typeof over === "object" && "draw" in over) {
        return { winnerPlayerID: null, isDraw: true };
      }
      return { winnerPlayerID: null, isDraw: false };
    },
  };

  cache.set(game as unknown as Game<unknown>, engine as Engine<unknown>);
  return engine;
}
