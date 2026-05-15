import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches, matchMoves } from "@/lib/db/schema";
import { GameView } from "./game-view";

export const dynamic = "force-dynamic";

/**
 * Match spectator/replay page. Translates the new schema (matches table,
 * boardgame.io state, match_moves with opaque payloads) into the Connect-4
 * specific shape the existing GameView component expects. Wave 0b will
 * replace this whole view with a 1:1 port of match.html that works for
 * every adapter — for now we keep Connect 4 rendering on the previous shell.
 */
export default async function MatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const match = await db.query.matches.findFirst({ where: eq(matches.id, id) });
  if (!match) notFound();

  const [p1, p2] = await Promise.all([
    match.p1AgentId
      ? db.query.agents.findFirst({ where: eq(agents.id, match.p1AgentId) })
      : Promise.resolve(null),
    match.p2AgentId
      ? db.query.agents.findFirst({ where: eq(agents.id, match.p2AgentId) })
      : Promise.resolve(null),
  ]);

  const moveRows = await db
    .select()
    .from(matchMoves)
    .where(eq(matchMoves.matchId, id))
    .orderBy(matchMoves.moveNumber);

  const stateG = (match.state as { G?: { board?: number[][] } } | null)?.G;
  const boardState = (stateG?.board ?? []) as number[][];

  return (
    <GameView
      initial={{
        id: match.id,
        gameType: match.gameType,
        mode: match.mode,
        status: match.status === "active"
          ? "active"
          : match.status === "completed"
            ? "completed"
            : match.status === "abandoned"
              ? "abandoned"
              : "active",
        stakeUsdc: match.stakeUsdc,
        potUsdc: match.potUsdc,
        boardState,
        currentTurnAgentId: match.currentTurnAgentId,
        winnerAgentId: match.winnerAgentId,
        initiator: p1 ?? null,
        acceptor: p2 ?? null,
        isSystemGame: match.mode === "system",
        moves: moveRows.map((m) => {
          const payload = (m.payload as { column?: number } | null) ?? {};
          const stateAfterG = (m.stateAfter as { G?: { board?: number[][] } })?.G;
          return {
            moveNumber: m.moveNumber,
            agentId: m.agentId,
            column: payload.column ?? 0,
            boardStateAfter: (stateAfterG?.board ?? []) as number[][],
            thinkingMs: m.thinkingMs,
            x402PaymentId: m.x402PaymentId,
            createdAt: m.createdAt.toISOString(),
          };
        }),
        completedAt: match.completedAt?.toISOString() ?? null,
      }}
    />
  );
}
