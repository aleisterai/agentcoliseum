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
 * Result of `serializeForSpectator`. `publicState` is what every viewer sees
 * (and is broadcast on the `match:{id}` channel). `privateAddendum`, if set,
 * is the bit of state the requesting agent is allowed to see in addition
 * (their own hand, ship positions, etc.) — only attached when the API call
 * was authenticated as that exact agent.
 *
 * For perfect-information games, `privateAddendum` is omitted; the public
 * state is the full state.
 */
export interface SpectatorView<TPublic = unknown, TPrivate = unknown> {
  publicState: TPublic;
  privateAddendum?: TPrivate;
}

/**
 * GameAdapter — the contract every game implements.
 *
 * `serializeForSpectator` is the security gate for imperfect-info games:
 * spectators and the opposing player must never see redacted state.
 */
export interface GameAdapter<TState = unknown, TMove = unknown> {
  /** URL-safe slug, e.g. "connect4", "chess". Stored in matches.game_type. */
  id: string;
  displayName: string;
  shortDescription: string;
  category: "classic" | "abstract" | "card" | "imperfect-info" | "dice";
  playerCount: 2;
  /** Markdown rules served at /rules/{id}.md for agents to fetch. */
  rulesMarkdown: string;
  /**
   * Per-game agent-API contract markdown. Drives the "For agents" tab on
   * /games/{id}. Documents the exact JSON move payload shape, examples,
   * idempotency, and error codes for THIS game.
   */
  apiContractMarkdown: string;
  /** boardgame.io game definition. Drives state, move legality, termination. */
  game: Game<TState>;
  /**
   * Frozen example state for catalog previews and the spotlight when no
   * live match exists. Should be representative (mid-game, both players'
   * pieces visible if perfect-info; placement-complete for imperfect-info).
   */
  previewState: TState;
  /**
   * Total per-agent clock budget in ms (e.g. Chess 600000 = 10 min). Each
   * agent's clock starts at this value and decrements as they think. Match
   * is forfeited on time when a clock reaches 0.
   */
  clockBudgetMs: number;
  /** Used to size hard match timeout (≈ 6× expected duration). */
  estimatedMovesPerGame: number;
  averageMoveTimeSec: number;
  /**
   * False for games with hidden information (Battleship, Liar's Dice).
   * `serializeForSpectator` MUST redact accordingly.
   */
  perfectInformation: boolean;
  /** System-bot strategies per difficulty. */
  bots: Record<BotDifficulty, BotStrategy<TState, TMove>>;
  /**
   * Serialize state for the wire.
   *
   * - For perfect-info games: return `{ publicState: state }`. The default
   *   `identityView` helper in adapters/_helpers.ts implements this.
   * - For imperfect-info games: strip every player's private bits from
   *   `publicState`. If `viewer` is `"0"` or `"1"` AND `gameOver` is false,
   *   attach that player's private bits as `privateAddendum`. On `gameOver`,
   *   the publicState may reveal everyone's hidden state.
   *
   * The API route only ever attaches `privateAddendum` when the request
   * was authenticated as that exact player. Spectators get just publicState.
   */
  serializeForSpectator(
    state: TState,
    viewer: ViewerRole,
    gameOver: boolean,
  ): SpectatorView;
  /**
   * Validate a move payload from an agent's API call before passing to
   * boardgame.io. Centralizes shape checks so the API route stays generic.
   */
  validateMovePayload(payload: unknown): ValidationResult<TMove>;
  /**
   * Convert a validated move into a boardgame.io action payload.
   * `moveName` is the key in `game.moves`; `args` is forwarded positionally.
   */
  toMoveAction(move: TMove): { moveName: string; args: unknown[] };
}

/**
 * Helper: trivial identity view for perfect-information games.
 *   serializeForSpectator: (state) => identityView(state)
 */
export function identityView<T>(state: T): SpectatorView<T, never> {
  return { publicState: state };
}
