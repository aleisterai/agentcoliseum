"use client";

import { useEffect, useMemo, useState } from "react";
import { BoardRenderer } from "@/components/game/board-renderer";
import { AgentRail } from "@/components/game/agent-rail";
import { MoveHistory } from "@/components/game/move-history";
import { ReplayControls, type ReplaySpeed } from "@/components/game/replay-controls";
import { Badge } from "@/components/ui/badge";
import { SpectatorCount } from "@/components/game/spectator-count";
import { emptyBoard } from "@/lib/game/games/connect4";
import { createPublicClient as createSupabasePublic, channelName, realtimeEvent } from "@/lib/supabase";
import { formatUsdc } from "@/lib/utils";
import { PageShell } from "@/components/layout/page-shell";

type Move = {
  moveNumber: number;
  agentId: string | null;
  column: number;
  boardStateAfter: number[][];
  thinkingMs: number;
  x402PaymentId: string | null;
  createdAt: string;
};

type Agent = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
};

export type GameViewProps = {
  initial: {
    id: string;
    gameType: string;
    mode: "free" | "paid" | "system";
    status: "lobby" | "active" | "completed" | "abandoned";
    stakeUsdc: number | null;
    potUsdc: number | null;
    boardState: number[][];
    currentTurnAgentId: string | null;
    winnerAgentId: string | null;
    initiator: Agent | null;
    acceptor: Agent | null;
    isSystemGame: boolean;
    moves: Move[];
    completedAt: string | null;
  };
};

export function GameView({ initial }: GameViewProps) {
  const [moves, setMoves] = useState<Move[]>(initial.moves);
  const [currentMoveIndex, setCurrentMoveIndex] = useState<number>(
    Math.max(0, initial.moves.length - 1),
  );
  const [liveMode, setLiveMode] = useState(initial.status === "active");
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [currentTurnAgentId, setCurrentTurnAgentId] = useState(initial.currentTurnAgentId);

  const displayedBoard = useMemo(() => {
    if (liveMode || moves.length === 0) {
      return moves.length > 0 ? moves[moves.length - 1].boardStateAfter : initial.boardState;
    }
    if (currentMoveIndex < 0) return emptyBoard();
    return moves[currentMoveIndex]?.boardStateAfter ?? emptyBoard();
  }, [liveMode, moves, currentMoveIndex, initial.boardState]);

  const lastMove = useMemo(() => {
    if (liveMode) {
      const m = moves[moves.length - 1];
      return m ? floorRow(m.boardStateAfter, m.column) : null;
    }
    const m = moves[currentMoveIndex];
    return m ? floorRow(m.boardStateAfter, m.column) : null;
  }, [liveMode, moves, currentMoveIndex]);

  // Live-region announcement for screen readers. Updates whenever a new move
  // becomes visible (live or scrubbed).
  const liveLabel = useMemo(() => {
    const idx = liveMode ? moves.length - 1 : currentMoveIndex;
    const m = moves[idx];
    if (!m) return "Empty board.";
    const who =
      m.agentId === initial.initiator?.id
        ? initial.initiator?.displayName
        : m.agentId === initial.acceptor?.id
          ? initial.acceptor?.displayName
          : "System bot";
    return `${who ?? "Player"} played column ${m.column + 1}. Move ${m.moveNumber + 1} of ${moves.length}.`;
  }, [liveMode, moves, currentMoveIndex, initial.initiator, initial.acceptor]);

  useEffect(() => {
    if (!isPlaying || moves.length === 0) return;
    const interval = 1000 / speed;
    const t = setInterval(() => {
      setCurrentMoveIndex((i) => {
        if (i >= moves.length - 1) {
          setIsPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, interval);
    return () => clearInterval(t);
  }, [isPlaying, speed, moves.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    try {
      const sb = createSupabasePublic();
      const ch = sb.channel(channelName.game(initial.id));
      ch.on("broadcast", { event: realtimeEvent.MovePlayed }, (e: { payload: unknown }) => {
        const p = e.payload as {
          moveNumber: number;
          column: number;
          boardStateAfter: number[][];
          currentTurnAgentId: string | null;
        };
        setMoves((m) => {
          if (m.some((x) => x.moveNumber === p.moveNumber)) return m;
          const synth: Move = {
            moveNumber: p.moveNumber,
            agentId:
              p.currentTurnAgentId === initial.initiator?.id
                ? initial.acceptor?.id ?? null
                : initial.initiator?.id ?? null,
            column: p.column,
            boardStateAfter: p.boardStateAfter,
            thinkingMs: 0,
            x402PaymentId: null,
            createdAt: new Date().toISOString(),
          };
          return [...m, synth];
        });
        setCurrentTurnAgentId(p.currentTurnAgentId);
        if (liveMode) setCurrentMoveIndex((i) => i + 1);
      });
      ch.on("broadcast", { event: realtimeEvent.GameEnded }, () => {
        setCurrentTurnAgentId(null);
      });
      ch.subscribe();
      return () => {
        sb.removeChannel(ch);
      };
    } catch {
      /* no env wired */
    }
  }, [initial.id, initial.initiator?.id, initial.acceptor?.id, liveMode]);

  const agentLookup = useMemo(() => {
    const out: Record<string, { handle: string; displayName: string }> = {};
    if (initial.initiator) out[initial.initiator.id] = initial.initiator;
    if (initial.acceptor) out[initial.acceptor.id] = initial.acceptor;
    return out;
  }, [initial.initiator, initial.acceptor]);

  return (
    // Tighter rhythm than the default PageShell so the board, agent rails, and
    // replay scrubber pack visually as one unit. !gap and !py override.
    <PageShell as="div" className="!gap-4 !py-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {initial.status === "active" && (
            <Badge variant="live">
              <span className="live-pulse mr-1" /> LIVE
            </Badge>
          )}
          {initial.status === "completed" && <Badge variant="outline">Completed</Badge>}
          {initial.status === "lobby" && <Badge variant="secondary">Lobby</Badge>}
          <Badge variant="outline" className="font-numeric uppercase tracking-wider">
            {initial.mode}
          </Badge>
          {initial.mode === "paid" && initial.potUsdc != null && (
            <Badge variant="gold" className="font-numeric">
              Pot {formatUsdc(initial.potUsdc)}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          <SpectatorCount gameId={initial.id} />
          <span className="font-numeric text-xs text-muted-foreground">{initial.id.slice(0, 8)}</span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_2fr_1fr]">
        <AgentRail
          agent={initial.initiator}
          isTurn={currentTurnAgentId === initial.initiator?.id}
          side="left"
        />
        <div className="flex flex-col gap-3">
          <BoardRenderer
            gameType={initial.gameType}
            state={{ board: displayedBoard }}
            lastMove={lastMove}
            liveLabel={liveLabel}
          />
          <ReplayControls
            moveCount={moves.length}
            currentIndex={Math.max(0, currentMoveIndex)}
            setCurrentIndex={setCurrentMoveIndex}
            isPlaying={isPlaying}
            setIsPlaying={setIsPlaying}
            speed={speed}
            setSpeed={setSpeed}
            liveMode={liveMode}
            setLiveMode={setLiveMode}
          />
        </div>
        <AgentRail
          agent={initial.isSystemGame ? null : initial.acceptor}
          isTurn={
            initial.isSystemGame
              ? currentTurnAgentId === null && initial.status === "active"
              : currentTurnAgentId === initial.acceptor?.id
          }
          side="right"
        />
      </div>

      <MoveHistory
        moves={moves}
        agents={agentLookup}
        onJump={(i) => {
          setLiveMode(false);
          setCurrentMoveIndex(i);
        }}
        currentMoveIndex={liveMode ? moves.length - 1 : currentMoveIndex}
      />
    </PageShell>
  );
}

function floorRow(board: number[][], col: number): [number, number] | null {
  for (let r = 0; r < board.length; r++) {
    if (board[r][col] !== 0) return [r, col];
  }
  return null;
}
