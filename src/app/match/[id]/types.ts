/**
 * Shared types for the match-view client component and its
 * extracted hooks/components.
 *
 * Kept in a sibling file (NOT exported from game-view.tsx) so the
 * extracted hooks can `import type { Move, ChatMessage }` without
 * pulling the entire component tree in as a circular dep.
 */

export type PlayerId = "0" | "1";

export type Move = {
  moveNumber: number;
  agentId: string | null;
  playerId: PlayerId;
  /** Game-specific move payload (e.g. { column: 3 } or { index: 4 }). */
  payload: unknown;
  /** boardgame.io G after the move was applied. Shape is gameType-specific. */
  stateAfterG: unknown;
  reasoning: string | null;
  evScore: number | null;
  thinkingMs: number;
  x402PaymentId: string | null;
  createdAt: string;
};

export type Agent = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  tokenCa: string | null;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  eloDelta: number | null;
  catchphrase: string | null;
  /** 7-day net earnings (microUSDC). Positive = green, negative = red. */
  earnings7dUsdc: number;
  coin: {
    address: string;
    symbol: string;
    name: string;
    uniswapBuyUrl: string;
    dexscreenerUrl: string;
  } | null;
};

export type ChatMessage = {
  id: string;
  speakerOwnerId: string | null;
  anonymousToken: string | null;
  body: string;
  createdAt: string;
};

export type MatchStatus =
  | "active"
  | "resolving"
  | "completed"
  | "abandoned"
  | "disputed";

export type MatchViewProps = {
  initial: {
    id: string;
    gameType: string;
    mode: "free" | "paid" | "system";
    status: MatchStatus;
    stakeUsdc: number | null;
    potUsdc: number | null;
    /** Initial boardgame.io G — shape varies per gameType. */
    stateG: unknown;
    currentTurnAgentId: string | null;
    currentTurnPlayerId: PlayerId;
    turnStartedAt: string;
    winnerAgentId: string | null;
    resultReason: string | null;
    clockBudgetMs: number;
    p1MsLeft: number;
    p2MsLeft: number;
    moveCount: number;
    p1: Agent | null;
    p2: Agent | null;
    isSystemGame: boolean;
    startedAt: string;
    completedAt: string | null;
    moves: Move[];
    chat: ChatMessage[];
    reactions: Array<{ emoji: string; count: number }>;
  };
};

export const REACTION_PALETTE = ["🔥", "🧠", "💀", "👀", "📈", "🩸", "🎯", "🤖"];
