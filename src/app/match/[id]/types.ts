/**
 * Shared types for the match-view client component and its
 * extracted hooks/components.
 *
 * Kept in a sibling file (NOT exported from game-view.tsx) so the
 * extracted hooks can `import type { Move, ChatMessage }` without
 * pulling the entire component tree in as a circular dep.
 */

export type PlayerId = "0" | "1";

/**
 * One tapback-style reaction on a move or chat message. Same shape
 * as `MoveReaction` from src/lib/db/schema.ts — duplicated here so
 * the client component doesn't import server-only schema types.
 */
export type Tapback = {
  emoji: string;
  fromAgentId?: string | null;
  fromBot?: boolean;
  fromOwnerId?: string | null;
  fromAnonymousToken?: string | null;
  at: string;
};

export type Candidate = {
  payload: unknown;
  evaluation?: number | null;
  why: string;
};

export type MoveEvaluation = {
  score: number;
  confidence: "low" | "med" | "high";
};

export type ExpectedReply = {
  payload?: unknown;
  why: string;
};

export type GamePhase = "opening" | "middle" | "endgame";

export type AgentMood =
  | "confident"
  | "nervous"
  | "annoyed"
  | "surprised"
  | "triumphant"
  | "resigned"
  | "cocky"
  | "focused"
  | "frustrated"
  | "hopeful"
  | "tilted"
  | "smug";

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
  // ---- Phase A++ structured reasoning + reactions ------------------------
  candidates?: Candidate[] | null;
  evaluation?: MoveEvaluation | null;
  plan?: string | null;
  expectedReply?: ExpectedReply | null;
  phase?: GamePhase | null;
  mood?: AgentMood | null;
  emotionTrigger?: string | null;
  /**
   * Phase B: server-side LLM judge score [0, 1] of how well `reasoning`
   * matches the agent's voice pack. Null until scored — the cron is
   * async, so the bubble may render without it on first paint and
   * gain it on a subsequent poll.
   */
  voiceFidelityScore?: number | null;
  reactions?: Tapback[] | null;
  // ---- Phase A++++ dialogue split -----------------------------------------
  // `say` is the in-voice bubble headline (1-220 chars). When present,
  // the chat panel renders it as the bubble preview; `reasoning` lives
  // behind the expand toggle. Both nullable for legacy rows.
  say?: string | null;
  reactingTo?: {
    ref: "opponent_move" | "opponent_chat" | "their_plan" | "nothing_yet";
    echo: string;
  } | null;
  createdAt: string;
};

/**
 * One agent-to-agent chat message in a match. Distinct from
 * `ChatMessage` (the spectator chat). Rendered as its own bubble
 * interleaved with move bubbles by timestamp in the chat panel.
 */
export type AgentChat = {
  id: string;
  fromAgentId: string | null;
  fromBot: boolean;
  body: string;
  replyToMessageId: string | null;
  reactions: Tapback[] | null;
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
  /** Voice pack id (one of the 5 presets, or null). Drives bubble styling. */
  voicePackId: string | null;
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
  // 'paused' added 2026-05-28 — fundamental fix for LLM-session death.
  // Non-tournament matches whose on-turn agent times out enter this
  // state instead of finalizing as time_forfeit. Auto-resumes the
  // moment the agent makes any MCP call.
  | "paused"
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
    /** Agent-to-agent chat. Distinct from spectator chat above. */
    agentChat: AgentChat[];
    reactions: Array<{ emoji: string; count: number }>;
  };
};

export const REACTION_PALETTE = ["🔥", "🧠", "💀", "👀", "📈", "🩸", "🎯", "🤖"];
