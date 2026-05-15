import type { Game } from "boardgame.io";

export type BotDifficulty = "easy" | "medium" | "hard";

export type ViewerRole = "0" | "1" | "spectator";

export interface BotStrategy<TState = unknown, TMove = unknown> {
  /**
   * Pick a move given the public game state and which player ID this bot is.
   * Implementations must be deterministic given (state, playerID, seed) so
   * tests and replays are reproducible.
   */
  pickMove(state: TState, playerID: "0" | "1"): TMove;
}

export type ValidationResult<TMove> =
  | { ok: true; move: TMove }
  | { ok: false; error: string };

/**
 * GameAdapter — the contract every game implements.
 *
 * The contract intentionally exposes a minimal surface so that swapping a
 * hand-rolled rules engine for a library-backed one (e.g. chess.js) is a
 * matter of populating the adapter, not changing call sites.
 */
export interface GameAdapter<TState = unknown, TMove = unknown> {
  /** URL-safe slug, e.g. "connect4", "chess". Stored in games.gameType. */
  id: string;
  displayName: string;
  shortDescription: string;
  category: "classic" | "abstract" | "card" | "imperfect-info" | "dice";
  playerCount: 2;
  /** Markdown rules served at /rules/{id}.md for agents to fetch. */
  rulesMarkdown: string;
  /** boardgame.io game definition. Drives state, move legality, termination. */
  game: Game<TState>;
  /** Used to size timeouts and replay scrubber defaults. */
  estimatedMovesPerGame: number;
  averageMoveTimeSec: number;
  /**
   * False for games with hidden information (e.g. Battleship, Liar's Dice).
   * `serializeForSpectator` must redact accordingly.
   */
  perfectInformation: boolean;
  /** System-bot strategies per difficulty. */
  bots: Record<BotDifficulty, BotStrategy<TState, TMove>>;
  /**
   * Serialize state for the wire. For perfect-info games, returning the raw
   * state is fine. For imperfect-info games, redact hidden information based
   * on viewer perspective: spectators get the fog-of-war view during play,
   * players see their own private state, and post-game everyone sees all.
   */
  serializeForSpectator(state: TState, viewer: ViewerRole, gameOver: boolean): unknown;
  /**
   * Validate a move payload from an agent's API call before passing to
   * boardgame.io. Centralizes shape checks so the API route stays generic.
   */
  validateMovePayload(payload: unknown): ValidationResult<TMove>;
  /**
   * Convert a validated move into a boardgame.io action payload.
   * `moveName` is the key in `game.moves`; `args` is forwarded as positional
   * args (the same shape boardgame.io uses internally).
   */
  toMoveAction(move: TMove): { moveName: string; args: unknown[] };
}
