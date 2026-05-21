import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  agents,
  matches,
  matchMoves,
  matchChat,
  matchChatMessages,
  matchReactions,
} from "@/lib/db/schema";
import { catalogEntry } from "@/lib/game/catalog";
import { readErc20Metadata } from "@/lib/chain/erc20-token";
import { MatchView } from "./game-view";

export const dynamic = "force-dynamic";

/**
 * Match-specific metadata + OG / Twitter card image — so shares of a
 * live match unfurl with the two-agent VS layout instead of the
 * generic site preview.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const match = await db.query.matches.findFirst({
    where: eq(matches.id, id),
    columns: {
      id: true,
      gameType: true,
      status: true,
      mode: true,
      potUsdc: true,
      p1AgentId: true,
      p2AgentId: true,
      winnerAgentId: true,
    },
  });
  if (!match) return { title: "Match not found" };

  const playerIds = [match.p1AgentId, match.p2AgentId].filter(Boolean) as string[];
  const players = playerIds.length
    ? await db
        .select({ id: agents.id, handle: agents.handle, displayName: agents.displayName })
        .from(agents)
        .where(inArray(agents.id, playerIds))
    : [];
  const p1 = players.find((p) => p.id === match.p1AgentId);
  const p2 = players.find((p) => p.id === match.p2AgentId);
  const gameLabel = catalogEntry(match.gameType)?.displayName ?? match.gameType;
  const statusLabel =
    match.status === "completed"
      ? "FINAL"
      : match.status === "active"
        ? "LIVE"
        : match.status.toUpperCase();
  const vs = `${p1?.handle ? "@" + p1.handle : "tbd"} vs ${p2?.handle ? "@" + p2.handle : "tbd"}`;
  const title = `${gameLabel} · ${vs} · ${statusLabel}`;
  const desc =
    match.mode === "paid" && match.potUsdc
      ? `${gameLabel} · ${(match.potUsdc / 1_000_000).toFixed(2)} USDC pot · ${vs}`
      : `${gameLabel} · free match · ${vs}`;
  const ogImage = `/api/og/match/${match.id}`;
  return {
    title,
    description: desc,
    alternates: { canonical: `/match/${match.id}` },
    openGraph: {
      title,
      description: desc,
      url: `/match/${match.id}`,
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: desc,
      images: [ogImage],
    },
  };
}

/**
 * Match page — server entry. Hydrates the full design-spec match view:
 * status strip, P1/P2 agent rails (with per-agent stats + clock), live board,
 * scrubber, move/x402/annotation tabs, reasoning trace, and spectator chat.
 *
 * All visual structure lives in the client component (MatchView). This file
 * only ferries the initial server snapshot.
 */
export default async function MatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const match = await db.query.matches.findFirst({ where: eq(matches.id, id) });
  if (!match) notFound();

  const [p1, p2, moveRows, chatRows, agentChatRows, reactionRows] = await Promise.all([
    match.p1AgentId
      ? db.query.agents.findFirst({ where: eq(agents.id, match.p1AgentId) })
      : Promise.resolve(null),
    match.p2AgentId
      ? db.query.agents.findFirst({ where: eq(agents.id, match.p2AgentId) })
      : Promise.resolve(null),
    db
      .select()
      .from(matchMoves)
      .where(eq(matchMoves.matchId, id))
      .orderBy(matchMoves.moveNumber),
    db
      .select()
      .from(matchChat)
      .where(eq(matchChat.matchId, id))
      .orderBy(desc(matchChat.createdAt))
      .limit(80),
    // Phase A++ — agent-to-agent chat for this match, oldest-first
    // (matches the spectator UI's display order).
    db
      .select()
      .from(matchChatMessages)
      .where(eq(matchChatMessages.matchId, id))
      .orderBy(matchChatMessages.createdAt),
    db
      .select({
        emoji: matchReactions.emoji,
        total: sql<number>`SUM(${matchReactions.count})::int`,
      })
      .from(matchReactions)
      .where(eq(matchReactions.matchId, id))
      .groupBy(matchReactions.emoji),
  ]);

  // Phase-1 rail enrichment: 7d net earnings + ERC-20 metadata for each
  // player. Both queries are scoped to the loaded agent IDs and run in
  // parallel; if a token CA isn't set or the read fails, coin stays null
  // and the rail simply omits the Buy CTA.
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [earningsRows, p1Coin, p2Coin] = await Promise.all([
    (p1 || p2)
      ? db
          .select({
            agentId: matches.winnerAgentId,
            netUsdc: sql<number>`COALESCE(SUM(${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0) - (${matches.potUsdc} / 2)), 0)::bigint`,
          })
          .from(matches)
          .where(
            and(
              eq(matches.status, "completed"),
              inArray(
                matches.winnerAgentId,
                [p1?.id, p2?.id].filter(Boolean) as string[],
              ),
              gte(matches.completedAt, since7d),
            ),
          )
          .groupBy(matches.winnerAgentId)
      : Promise.resolve([]),
    p1?.tokenCa
      ? readErc20Metadata(p1.tokenCa as `0x${string}`)
      : Promise.resolve(null),
    p2?.tokenCa
      ? readErc20Metadata(p2.tokenCa as `0x${string}`)
      : Promise.resolve(null),
  ]);
  const earningsByAgent: Record<string, number> = Object.fromEntries(
    earningsRows.map((r) => [r.agentId ?? "", Number(r.netUsdc)]),
  );

  function buildCoinPayload(meta: typeof p1Coin) {
    if (!meta) return null;
    return {
      address: meta.address,
      symbol: meta.symbol,
      name: meta.name,
      uniswapBuyUrl: `https://app.uniswap.org/swap?outputCurrency=${meta.address}&chain=base`,
      dexscreenerUrl: `https://dexscreener.com/base/${meta.address.toLowerCase()}`,
    };
  }

  // For each agent: pull recent record vs everyone else (cheap aggregate from
  // the per-agent counters we already maintain).
  // Pass the boardgame.io G through opaquely — each gameType's renderer
  // knows how to read its own shape. (Connect 4 has `board: number[][]`,
  // tic-tac-toe has `board: number[]`, etc.)
  const stateG = (match.state as { G?: unknown } | null)?.G ?? null;

  return (
    <MatchView
      initial={{
        id: match.id,
        gameType: match.gameType,
        mode: match.mode,
        status: match.status,
        stakeUsdc: match.stakeUsdc,
        potUsdc: match.potUsdc,
        stateG,
        currentTurnAgentId: match.currentTurnAgentId,
        currentTurnPlayerId: match.currentTurnPlayerId,
        turnStartedAt: match.turnStartedAt.toISOString(),
        winnerAgentId: match.winnerAgentId,
        resultReason: match.resultReason,
        clockBudgetMs: match.clockBudgetMs,
        p1MsLeft: match.p1MsLeft,
        p2MsLeft: match.p2MsLeft,
        moveCount: match.moveCount,
        p1: p1
          ? {
              id: p1.id,
              handle: p1.handle,
              displayName: p1.displayName,
              avatarUrl: p1.avatarUrl,
              tokenCa: p1.tokenCa,
              elo: p1.elo,
              wins: p1.wins,
              losses: p1.losses,
              draws: p1.draws,
              eloDelta: match.p1EloDelta,
              catchphrase: p1.catchphrase,
              voicePackId: p1.voicePackId,
              earnings7dUsdc: earningsByAgent[p1.id] ?? 0,
              coin: buildCoinPayload(p1Coin),
            }
          : null,
        p2: p2
          ? {
              id: p2.id,
              handle: p2.handle,
              displayName: p2.displayName,
              avatarUrl: p2.avatarUrl,
              tokenCa: p2.tokenCa,
              elo: p2.elo,
              wins: p2.wins,
              losses: p2.losses,
              draws: p2.draws,
              eloDelta: match.p2EloDelta,
              catchphrase: p2.catchphrase,
              voicePackId: p2.voicePackId,
              earnings7dUsdc: earningsByAgent[p2.id] ?? 0,
              coin: buildCoinPayload(p2Coin),
            }
          : null,
        isSystemGame: match.mode === "system",
        startedAt: match.startedAt.toISOString(),
        completedAt: match.completedAt?.toISOString() ?? null,
        moves: moveRows.map((m) => {
          const stateAfterG = (m.stateAfter as { G?: unknown } | null)?.G ?? null;
          return {
            moveNumber: m.moveNumber,
            agentId: m.agentId,
            playerId: m.playerId,
            payload: m.payload as unknown,
            stateAfterG,
            reasoning: m.reasoning,
            evScore: m.evScore,
            thinkingMs: m.thinkingMs,
            x402PaymentId: m.x402PaymentId,
            // Phase A++ — structured reasoning + reactions pass-through.
            candidates: (m.candidates as unknown) as Array<{ payload: unknown; evaluation?: number | null; why: string }> | null,
            evaluation: m.evaluation as { score: number; confidence: "low" | "med" | "high" } | null,
            plan: m.plan,
            expectedReply: m.expectedReply as { payload?: unknown; why: string } | null,
            phase: m.phase as "opening" | "middle" | "endgame" | null,
            mood: m.mood as
              | "confident" | "nervous" | "annoyed" | "surprised" | "triumphant"
              | "resigned" | "cocky" | "focused" | "frustrated" | "hopeful"
              | "tilted" | "smug" | null,
            emotionTrigger: m.emotionTrigger,
            // Phase B-C: LLM judge score [0, 1]. Set by the async
            // voice-fidelity-score cron — null for moves whose score
            // hasn't been computed yet (typically the most recent ones).
            voiceFidelityScore: m.voiceFidelityScore,
            reactions: (m.reactions as unknown) as Array<{
              emoji: string;
              fromAgentId?: string | null;
              fromBot?: boolean;
              fromOwnerId?: string | null;
              fromAnonymousToken?: string | null;
              at: string;
            }> | null,
            createdAt: m.createdAt.toISOString(),
          };
        }),
        chat: chatRows
          .map((c) => ({
            id: c.id,
            speakerOwnerId: c.speakerOwnerId,
            anonymousToken: c.anonymousToken,
            body: c.body,
            createdAt: c.createdAt.toISOString(),
          }))
          .reverse(),
        agentChat: agentChatRows.map((c) => ({
          id: c.id,
          fromAgentId: c.fromAgentId,
          fromBot: c.fromBot,
          body: c.body,
          replyToMessageId: c.replyToMessageId,
          reactions: (c.reactions as unknown) as Array<{
            emoji: string;
            fromAgentId?: string | null;
            fromBot?: boolean;
            fromOwnerId?: string | null;
            fromAnonymousToken?: string | null;
            at: string;
          }> | null,
          createdAt: c.createdAt.toISOString(),
        })),
        reactions: reactionRows.map((r) => ({ emoji: r.emoji, count: r.total })),
      }}
    />
  );
}
