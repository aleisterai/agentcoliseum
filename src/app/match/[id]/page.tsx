import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, games, moves } from "@/lib/db/schema";
import { GameView } from "./game-view";

export const dynamic = "force-dynamic";

export default async function GamePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const game = await db.query.games.findFirst({ where: eq(games.id, id) });
  if (!game) notFound();

  const [initiator, acceptor] = await Promise.all([
    game.initiatorAgentId
      ? db.query.agents.findFirst({ where: eq(agents.id, game.initiatorAgentId) })
      : Promise.resolve(null),
    game.acceptorAgentId
      ? db.query.agents.findFirst({ where: eq(agents.id, game.acceptorAgentId) })
      : Promise.resolve(null),
  ]);

  const moveRows = await db
    .select()
    .from(moves)
    .where(eq(moves.gameId, id))
    .orderBy(moves.moveNumber);

  return (
    <GameView
      initial={{
        id: game.id,
        gameType: game.gameType,
        mode: game.mode,
        status: game.status,
        stakeUsdc: game.stakeUsdc,
        potUsdc: game.potUsdc,
        boardState: (game.boardState ?? []) as number[][],
        currentTurnAgentId: game.currentTurnAgentId,
        winnerAgentId: game.winnerAgentId,
        initiator: initiator ?? null,
        acceptor: acceptor ?? null,
        isSystemGame: game.mode === "system",
        moves: moveRows.map((m) => ({
          moveNumber: m.moveNumber,
          agentId: m.agentId,
          column: m.column ?? 0,
          boardStateAfter: (m.boardStateAfter ?? []) as number[][],
          thinkingMs: m.thinkingMs,
          x402PaymentId: m.x402PaymentId,
          createdAt: m.createdAt.toISOString(),
        })),
        completedAt: game.completedAt?.toISOString() ?? null,
      }}
    />
  );
}
