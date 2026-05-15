/**
 * Rolling state snapshots for replay performance.
 *
 * Every `match_moves` row stores `state_after` — the full state after that
 * move. With that in place, scrubbing in the UI is just an index lookup
 * (`moves[targetMove].stateAfter`), no replay through boardgame.io.
 *
 * For a finished match we also write a single `match_transcripts` row
 * containing the canonical payload: ordered moves + state-at-each + final
 * revealed state. This is what the match page hydrates on first load.
 *
 * This module is the producer/consumer of that payload — pure functions,
 * no DB calls. Persistence is done by server-flow's finalizeMatch.
 */
import type { State } from "boardgame.io";
import type { GameAdapter } from "./types";

/** One frame in a transcript. */
export interface TranscriptFrame {
  moveNumber: number;
  agentId: string | null;
  playerId: "0" | "1";
  payload: unknown;
  reasoning: string | null;
  evScore: number | null;
  thinkingMs: number;
  x402PaymentId: string | null;
  /** State *after* this move was applied. Full State<TG>. */
  stateAfter: unknown;
  /** Spectator view at this point — public state only (no hidden info). */
  publicStateAfter: unknown;
  createdAt: string; // ISO
}

/** What gets stored in `match_transcripts.payload`. */
export interface MatchTranscriptPayload {
  matchId: string;
  gameType: string;
  /** boardgame.io state at move 0 — the initial setup. */
  initialState: unknown;
  /** Spectator view of the initial state. */
  initialPublicState: unknown;
  frames: TranscriptFrame[];
  /** Set when the match ended — full state with hidden info revealed. */
  finalState: unknown;
  /** Spectator-safe final state (same as finalState for perfect-info games). */
  finalPublicState: unknown;
  /** "natural" | "time_forfeit" | etc. */
  resultReason: string;
  winnerAgentId: string | null;
  durationMs: number;
  totalMoves: number;
}

/** Build a transcript payload from raw move rows + final state. */
export function buildTranscript<TG, TM>(args: {
  matchId: string;
  adapter: GameAdapter<TG, TM>;
  initialState: State<TG>;
  moves: Array<{
    moveNumber: number;
    agentId: string | null;
    playerId: "0" | "1";
    payload: unknown;
    reasoning: string | null;
    evScore: number | null;
    thinkingMs: number;
    x402PaymentId: string | null;
    stateAfter: State<TG>;
    createdAt: Date;
  }>;
  finalState: State<TG>;
  resultReason: string;
  winnerAgentId: string | null;
  startedAt: Date;
  completedAt: Date;
}): MatchTranscriptPayload {
  const { adapter } = args;
  const initialPublic = adapter.serializeForSpectator(
    args.initialState.G,
    "spectator",
    false,
  );
  const finalPublic = adapter.serializeForSpectator(
    args.finalState.G,
    "spectator",
    true,
  );
  return {
    matchId: args.matchId,
    gameType: adapter.id,
    initialState: args.initialState,
    initialPublicState: initialPublic.publicState,
    frames: args.moves.map((m, idx): TranscriptFrame => {
      const isFinalMove = idx === args.moves.length - 1;
      const view = adapter.serializeForSpectator(
        m.stateAfter.G,
        "spectator",
        isFinalMove,
      );
      return {
        moveNumber: m.moveNumber,
        agentId: m.agentId,
        playerId: m.playerId,
        payload: m.payload,
        reasoning: m.reasoning,
        evScore: m.evScore,
        thinkingMs: m.thinkingMs,
        x402PaymentId: m.x402PaymentId,
        stateAfter: m.stateAfter,
        publicStateAfter: view.publicState,
        createdAt: m.createdAt.toISOString(),
      };
    }),
    finalState: args.finalState,
    finalPublicState: finalPublic.publicState,
    resultReason: args.resultReason,
    winnerAgentId: args.winnerAgentId,
    durationMs: args.completedAt.getTime() - args.startedAt.getTime(),
    totalMoves: args.moves.length,
  };
}

/**
 * Quick lookup: state at a given move number from a transcript. Used by
 * the replay scrubber so seeking doesn't replay moves.
 */
export function stateAtMove(
  transcript: MatchTranscriptPayload,
  moveNumber: number,
): unknown {
  if (moveNumber <= 0) return transcript.initialPublicState;
  const frame = transcript.frames[moveNumber - 1];
  return frame ? frame.publicStateAfter : transcript.finalPublicState;
}
