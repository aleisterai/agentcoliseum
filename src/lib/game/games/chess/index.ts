import type { GameAdapter } from "@/lib/game/types";
import { identityView } from "@/lib/game/types";
import {
  applyMove,
  game as chessGame,
  legalMoves,
  squareIndex,
  startingState,
  type ChessState,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

export type ChessMove = { from: string; to: string; promotion?: "Q" | "R" | "B" | "N" };

/**
 * Representative mid-game preview: after 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 — the
 * Ruy Lopez. Shows kings still home, both colors developing pieces, neither
 * side winning. Used by catalog cards / spotlight when no live match exists.
 */
const previewState: ChessState = (() => {
  let s = startingState();
  const sequence: Array<[string, string]> = [
    ["e2", "e4"], ["e7", "e5"],
    ["g1", "f3"], ["b8", "c6"],
    ["f1", "b5"], ["a7", "a6"],
  ];
  for (const [from, to] of sequence) {
    const fromIdx = squareIndex(from);
    const toIdx = squareIndex(to);
    const moves = legalMoves(s);
    const match = moves.find((m) => m.from === fromIdx && m.to === toIdx);
    if (!match) throw new Error(`chess preview: illegal seed move ${from}-${to}`);
    s = applyMove(s, match);
  }
  return s;
})();

export const chessAdapter: GameAdapter<ChessState, ChessMove> = {
  id: "chess",
  displayName: "Chess",
  shortDescription: "The classic 8×8 royal game.",
  category: "classic",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: chessGame,
  previewState,
  // 10 minutes per agent.
  clockBudgetMs: 10 * 60 * 1000,
  estimatedMovesPerGame: 60,
  averageMoveTimeSec: 8,
  perfectInformation: true,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator: (state) => identityView(state),
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const p = payload as Record<string, unknown>;
    if (typeof p.from !== "string" || typeof p.to !== "string") {
      return { ok: false, error: "from and to must be square names like 'e2'" };
    }
    // Validate square name format (a-h)(1-8). squareIndex throws otherwise.
    try {
      squareIndex(p.from);
      squareIndex(p.to);
    } catch {
      return { ok: false, error: "from/to must match /^[a-h][1-8]$/" };
    }
    const promo = p.promotion;
    if (promo != null && promo !== "Q" && promo !== "R" && promo !== "B" && promo !== "N") {
      return { ok: false, error: "promotion must be one of Q, R, B, N" };
    }
    const move: ChessMove = {
      from: p.from,
      to: p.to,
      ...(promo != null ? { promotion: promo as "Q" | "R" | "B" | "N" } : {}),
    };
    return { ok: true, move };
  },
  toMoveAction: (move) => ({ moveName: "play", args: [move] }),
};

export * from "./game";
