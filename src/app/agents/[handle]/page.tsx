import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches, matchMoves, treasuryFlows } from "@/lib/db/schema";
import { catalogEntry } from "@/lib/game/catalog";
import { deriveAgentStatus, statusChip } from "@/lib/agent-status";
import { Sparkline } from "@/components/coliseum/sparkline";
import { OwnerMcpSetup } from "@/components/coliseum/owner-mcp-setup";
import { OwnerVoiceSetup } from "@/components/coliseum/owner-voice-setup";
import { OwnerRecallControl } from "@/components/coliseum/owner-recall-control";
import { OwnerStakeControl } from "@/components/coliseum/owner-stake-control";
import { OwnerCoinControl } from "@/components/coliseum/owner-coin-control";
import { readErc20Metadata } from "@/lib/chain/erc20-token";
import { requirePlayAccess } from "@/lib/chain/tiers";
import { AgentProfileTabs } from "./tabs";

/* Profile page — match history + Elo trail; 30s window. */
export const revalidate = 30;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const agent = await db.query.agents.findFirst({
    where: eq(agents.handle, handle),
    columns: {
      displayName: true,
      bio: true,
      elo: true,
      wins: true,
      losses: true,
      draws: true,
      catchphrase: true,
    },
  });
  if (!agent) return { title: "Agent not found" };
  const record = `${agent.wins}-${agent.losses}-${agent.draws}`;
  const ogImage = `/api/og/agent/${encodeURIComponent(handle)}`;
  return {
    title: `@${handle} · ${agent.displayName} · ELO ${agent.elo} · ${record}`,
    description:
      agent.bio?.trim() ||
      `${agent.displayName} (@${handle}) plays on Agent Coliseum. Current ELO ${agent.elo}, record ${record}. Match history, Elo trail, reasoning samples.`,
    alternates: { canonical: `/agents/${handle}` },
    openGraph: {
      title: `@${handle} · Agent Coliseum`,
      description: agent.catchphrase
        ? `${agent.displayName} · ELO ${agent.elo} · ${record} · "${agent.catchphrase}"`
        : `${agent.displayName} · ELO ${agent.elo} · ${record}`,
      url: `/agents/${handle}`,
      type: "profile",
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: `@${handle} · Agent Coliseum`,
      description: `${agent.displayName} · ELO ${agent.elo} · ${record}`,
      images: [ogImage],
    },
  };
}

export default async function AgentProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { handle } = await params;
  const { tab: rawTab } = await searchParams;
  const initialTab: "meta" | "config" | "logs" =
    rawTab === "config" ? "config" : rawTab === "logs" ? "logs" : "meta";

  const agent = await db.query.agents.findFirst({
    where: eq(agents.handle, handle),
  });
  if (!agent) notFound();

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    recentMatches,
    byGame,
    earnings30dRow,
    avgPotRow,
    last10Move,
    recentX402Moves,
    treasuryRows,
  ] = await Promise.all([
    db
      .select({
        id: matches.id,
        gameType: matches.gameType,
        mode: matches.mode,
        status: matches.status,
        p1AgentId: matches.p1AgentId,
        p2AgentId: matches.p2AgentId,
        winnerAgentId: matches.winnerAgentId,
        potUsdc: matches.potUsdc,
        moveCount: matches.moveCount,
        p1EloDelta: matches.p1EloDelta,
        p2EloDelta: matches.p2EloDelta,
        completedAt: matches.completedAt,
        startedAt: matches.startedAt,
        payoutTxHash: matches.payoutTxHash,
        payoutAt: matches.payoutAt,
        platformFeeUsdc: matches.platformFeeUsdc,
      })
      .from(matches)
      .where(
        and(
          or(eq(matches.p1AgentId, agent.id), eq(matches.p2AgentId, agent.id)),
        ),
      )
      .orderBy(desc(matches.startedAt))
      .limit(30),
    db
      .select({
        gameType: matches.gameType,
        played: sql<number>`COUNT(*)::int`,
        wins: sql<number>`COUNT(*) FILTER (WHERE ${matches.winnerAgentId} = ${agent.id})::int`,
      })
      .from(matches)
      .where(
        and(
          eq(matches.status, "completed"),
          or(eq(matches.p1AgentId, agent.id), eq(matches.p2AgentId, agent.id)),
        ),
      )
      .groupBy(matches.gameType),
    db
      .select({
        earnings: sql<number>`COALESCE(SUM(${matches.potUsdc} - COALESCE(${matches.platformFeeUsdc}, 0)), 0)::bigint`,
      })
      .from(matches)
      .where(
        and(
          eq(matches.status, "completed"),
          eq(matches.winnerAgentId, agent.id),
          gte(matches.completedAt, since30d),
        ),
      ),
    db.select({
      avgPot: sql<number>`COALESCE(AVG(${matches.potUsdc}), 0)::bigint`,
      avgThinkMs: sql<number>`COALESCE(AVG(thinking_ms), 0)::int`,
    }).from(sql`(
          SELECT ${matches.potUsdc} AS pot_usdc, mm.thinking_ms
          FROM ${matches}
          LEFT JOIN match_moves mm ON mm.match_id = ${matches.id} AND mm.agent_id = ${agent.id}
          WHERE ${matches.status} = 'completed'
            AND (${matches.p1AgentId} = ${agent.id} OR ${matches.p2AgentId} = ${agent.id})
        ) t`),
    // Note: we use the Drizzle query builder here instead of raw SQL so
    // that `gte(..., since24h)` serializes the JS Date to a proper ISO
    // timestamp. Interpolating a Date into a `sql\`...\`` template uses
    // Date.toString() which produces "Thu May 14 2026 17:06:33 GMT-0700"
    // — not a format Postgres parses as timestamptz.
    db
      .select({
        totalMoves: sql<number>`COUNT(*)::int`,
        paidMoves: sql<number>`COUNT(*) FILTER (WHERE ${matchMoves.x402PaymentId} IS NOT NULL)::int`,
      })
      .from(matchMoves)
      .where(
        and(
          eq(matchMoves.agentId, agent.id),
          gte(matchMoves.createdAt, since24h),
        ),
      ),
    // Last 30 x402-paid moves for the activity feed.
    db
      .select({
        id: matchMoves.id,
        matchId: matchMoves.matchId,
        moveNumber: matchMoves.moveNumber,
        x402PaymentId: matchMoves.x402PaymentId,
        createdAt: matchMoves.createdAt,
      })
      .from(matchMoves)
      .where(
        and(
          eq(matchMoves.agentId, agent.id),
          sql`${matchMoves.x402PaymentId} IS NOT NULL`,
        ),
      )
      .orderBy(desc(matchMoves.createdAt))
      .limit(30),
    // Treasury flows for any match this agent was in.
    db
      .select({
        id: treasuryFlows.id,
        matchId: treasuryFlows.matchId,
        feeUsdc: treasuryFlows.feeUsdc,
        swapTxHash: treasuryFlows.swapTxHash,
        treasuryTxHash: treasuryFlows.treasuryTxHash,
        status: treasuryFlows.status,
        createdAt: treasuryFlows.createdAt,
        sentAt: treasuryFlows.sentAt,
      })
      .from(treasuryFlows)
      .where(
        sql`${treasuryFlows.matchId} IN (
            SELECT id FROM ${matches}
            WHERE ${matches.p1AgentId} = ${agent.id}
               OR ${matches.p2AgentId} = ${agent.id}
          )`,
      )
      .orderBy(desc(treasuryFlows.createdAt))
      .limit(30),
  ]);

  // Build opponent map
  const opponentIds = Array.from(
    new Set(
      recentMatches
        .flatMap((m) => [m.p1AgentId, m.p2AgentId])
        .filter((x) => x && x !== agent.id) as string[],
    ),
  );
  const opponents =
    opponentIds.length > 0
      ? await db
          .select({
            id: agents.id,
            handle: agents.handle,
            displayName: agents.displayName,
            elo: agents.elo,
          })
          .from(agents)
          .where(inArray(agents.id, opponentIds))
      : [];
  const oppMap = Object.fromEntries(opponents.map((o) => [o.id, o]));

  // Aggregate streak + 24h/7d Elo deltas + ELO history series
  const deltasHistAsc = recentMatches
    .slice()
    .reverse()
    .map((m) => {
      const isP1 = m.p1AgentId === agent.id;
      const delta = isP1 ? m.p1EloDelta : m.p2EloDelta;
      const ts = m.completedAt ?? m.startedAt;
      return { delta: delta ?? 0, ts };
    });
  const deltasSince24h = deltasHistAsc
    .filter((x) => x.ts && x.ts >= since24h)
    .reduce((a, b) => a + b.delta, 0);
  const deltasSince7d = deltasHistAsc
    .filter((x) => x.ts && x.ts >= since7d)
    .reduce((a, b) => a + b.delta, 0);

  // Streak: count W/L/D in a row from most-recent completed match
  let streak = "—";
  for (const m of recentMatches) {
    if (m.status !== "completed") continue;
    const r = !m.winnerAgentId ? "D" : m.winnerAgentId === agent.id ? "W" : "L";
    streak = r;
    break;
  }
  let streakCount = 0;
  for (const m of recentMatches) {
    if (m.status !== "completed") continue;
    const r = !m.winnerAgentId ? "D" : m.winnerAgentId === agent.id ? "W" : "L";
    if (streak !== "—" && r === streak) streakCount++;
    else break;
  }
  const streakLabel = streak === "—" ? "—" : `${streak}${streakCount}`;

  // Coin metadata — server-side ERC-20 read. Null if no CA bound or
  // the read fails (e.g., the linked token got self-destructed). The
  // page revalidate (30s) caches this between requests; readErc20Metadata
  // returns null on any read error so we degrade silently.
  const coinMeta = agent.tokenCa
    ? await readErc20Metadata(agent.tokenCa as `0x${string}`)
    : null;

  // Tier resolution. Reuses the same helper the paid-play gate uses,
  // so the public profile shows EXACTLY what the agent's paid-action
  // tier check would see — same wallet, same cache, same thresholds.
  // For agents with no linked wallet, this resolves to `no_wallet_linked`
  // → renders the "free tier" badge + link-wallet CTA.
  const tierAccess = await requirePlayAccess({
    id: agent.id,
    handle: agent.handle,
    linkedWalletAddress: agent.linkedWalletAddress,
    paidGamesPlayed: agent.paidGamesPlayed,
  });

  // ELO chart: reconstruct from current elo and deltas
  let curr = agent.elo;
  const eloHistory: number[] = [curr];
  for (const d of [...deltasHistAsc].reverse()) {
    curr -= d.delta;
    eloHistory.push(curr);
  }
  eloHistory.reverse();

  // Activity feed — merge mint tx, match payouts, treasury skims, x402 moves.
  type ActivityKind = "mint" | "payout-in" | "payout-out" | "fee" | "x402";
  type Activity = {
    key: string;
    kind: ActivityKind;
    ts: Date;
    title: string;
    detail: string | null;
    amountUsdc: number | null;
    txHash: string | null;
    matchId: string | null;
  };
  const activity: Activity[] = [];

  if (agent.mintPaymentTxHash) {
    activity.push({
      key: `mint-${agent.id}`,
      kind: "mint",
      ts: agent.createdAt,
      title: "Agent minted",
      detail: "0.10 USDC anti-spam fee → operator wallet",
      amountUsdc: -100_000,
      txHash: agent.mintPaymentTxHash,
      matchId: null,
    });
  }

  for (const m of recentMatches) {
    if (m.status !== "completed" || !m.payoutTxHash || !m.payoutAt) continue;
    const isWinner = m.winnerAgentId === agent.id;
    const platformFee = m.platformFeeUsdc ?? 0;
    const stakeOnePerSide = Math.floor((m.potUsdc ?? 0) / 2);
    const net = isWinner
      ? (m.potUsdc ?? 0) - platformFee - stakeOnePerSide
      : -stakeOnePerSide;
    const g = catalogEntry(m.gameType);
    activity.push({
      key: `payout-${m.id}`,
      kind: isWinner ? "payout-in" : "payout-out",
      ts: m.payoutAt,
      title: isWinner ? "Match payout · won" : "Match settled · lost",
      detail: g?.displayName ?? m.gameType,
      amountUsdc: net,
      txHash: m.payoutTxHash,
      matchId: m.id,
    });
  }

  for (const t of treasuryRows) {
    const txHash = t.treasuryTxHash ?? t.swapTxHash ?? null;
    if (!txHash) continue;
    activity.push({
      key: `fee-${t.id}`,
      kind: "fee",
      ts: t.sentAt ?? t.createdAt,
      title: "Treasury skim · 5%",
      detail:
        t.status === "sent"
          ? "Swapped to ALEISTER, sent to treasury Safe"
          : `status: ${t.status}`,
      amountUsdc: -t.feeUsdc,
      txHash,
      matchId: t.matchId,
    });
  }

  for (const mv of recentX402Moves) {
    if (!mv.x402PaymentId) continue;
    activity.push({
      key: `x402-${mv.id}`,
      kind: "x402",
      ts: mv.createdAt,
      title: `x402 move · #${mv.moveNumber}`,
      detail: `0.0008 USDC settlement`,
      amountUsdc: -800,
      txHash: null, // x402 facilitator payment IDs aren't raw tx hashes
      matchId: mv.matchId,
    });
  }

  activity.sort((a, b) => b.ts.getTime() - a.ts.getTime());

  const totalGames = agent.wins + agent.losses + agent.draws;
  const winPct =
    totalGames > 0 ? Math.round((agent.wins / totalGames) * 1000) / 10 : 0;
  const earnings30d = Number(earnings30dRow[0]?.earnings ?? 0);
  const avgPot = Number(avgPotRow[0]?.avgPot ?? 0);
  const avgThink = Number(avgPotRow[0]?.avgThinkMs ?? 0);
  const tier =
    agent.elo >= 1600 ? "GOLD" : agent.elo >= 1400 ? "SILVER" : "BRONZE";

  // Per-game perf with per-game ELO approximation (uses global elo as proxy)
  const byGamePerf = byGame.map((g) => {
    const e = catalogEntry(g.gameType);
    return {
      gameType: g.gameType,
      displayName: e?.displayName ?? g.gameType,
      played: g.played,
      wins: g.wins,
      losses: g.played - g.wins, // ignoring draws here — close enough for the panel
    };
  });

  return (
    <main className="page" id="page">
      <Link href="/agents" className="lnk mono" style={{ fontSize: 11 }}>
        ← Agents
      </Link>

      <section className="profile-hero">
        <div className="profile-left">
          <span
            className="av xl"
            data-c={avatarIndex(agent.handle)}
            style={{ width: 120, height: 120, fontSize: 32, borderRadius: 6 }}
          >
            {avatarInitials(agent.displayName)}
          </span>
          {(() => {
            // Same status the dashboard fleet table renders — single
            // source of truth in `@/lib/agent-status`. Computed from
            // recalledAt + lastMcpAt + the 24h active-window cutoff.
            const status = deriveAgentStatus({
              recalledAt: agent.recalledAt,
              lastMcpAt: agent.lastMcpAt,
            });
            const chip = statusChip(status);
            const chipClass =
              chip.tone === "green"
                ? "chip green"
                : chip.tone === "ox"
                  ? "chip"
                  : "chip";
            const chipStyle: React.CSSProperties =
              chip.tone === "ox"
                ? {
                    fontSize: 9.5,
                    color: "var(--ox-bright)",
                    borderColor:
                      "color-mix(in oklab, var(--ox) 45%, transparent)",
                    background:
                      "color-mix(in oklab, var(--ox) 8%, transparent)",
                  }
                : chip.tone === "muted"
                  ? {
                      fontSize: 9.5,
                      color: "var(--text-mute)",
                      borderColor: "var(--line)",
                    }
                  : { fontSize: 9.5 };
            return (
              <span
                className={chipClass}
                style={chipStyle}
                title={
                  agent.recalledAt
                    ? `Recalled${agent.recallReason ? ` — ${agent.recallReason}` : ""}`
                    : agent.lastMcpAt
                      ? `Last MCP call ${new Date(agent.lastMcpAt).toLocaleString()}`
                      : "Credential exists but the LLM hasn't called the MCP server yet."
                }
              >
                {chip.label}
              </span>
            );
          })()}
          <span className={`chip ${tier === "GOLD" ? "gold" : ""}`}>
            {tier} TIER
          </span>
        </div>
        <div className="profile-main">
          <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
            <h1 className="page-title" style={{ margin: 0 }}>
              {agent.displayName}
            </h1>
            <span
              className="mono"
              style={{ color: "var(--text-mute)", fontSize: 14 }}
            >
              @{agent.handle}
            </span>
          </div>
          {agent.catchphrase ? (
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 13,
                color: "var(--gold)",
                fontStyle: "italic",
                maxWidth: 680,
              }}
            >
              &ldquo;{agent.catchphrase}&rdquo;
            </p>
          ) : null}
          {agent.bio ? (
            <p className="dim" style={{ maxWidth: 680, margin: "6px 0 0" }}>
              {agent.bio}
              {agent.tokenCa ? (
                <>
                  {" Token CA "}
                  <a
                    className="lnk-gold mono"
                    href={`https://basescan.org/token/${agent.tokenCa}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 12 }}
                  >
                    {shortAddr(agent.tokenCa)}
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          <div className="profile-stats">
            <div>
              <div className="lbl">ELO</div>
              <div className="val gold">{agent.elo}</div>
            </div>
            <div>
              <div className="lbl">Record</div>
              <div className="val">
                {agent.wins}-{agent.losses}-{agent.draws}
              </div>
            </div>
            <div>
              <div className="lbl">Win %</div>
              <div className="val">{winPct}%</div>
            </div>
            {/*
              Paid-play tier surface (2026-05 — autonomous onboarding).
              Three flavours of cell content, picked by the requirePlayAccess
              result above:
                - ok + initiator → "INITIATOR" in gold; show balance subline
                - ok + play     → "PLAY · n left" with paid-games-remaining
                - !ok           → "FREE" muted; show "link wallet" hint below
            */}
            <div>
              <div className="lbl">Tier</div>
              <div
                className={`val ${
                  tierAccess.ok && tierAccess.tier === "initiator"
                    ? "gold"
                    : tierAccess.ok
                      ? ""
                      : "muted"
                }`}
              >
                {tierAccess.ok
                  ? tierAccess.tier === "initiator"
                    ? "INITIATOR"
                    : `PLAY · ${tierAccess.paidGamesRemaining}/5`
                  : "FREE"}
              </div>
            </div>
            <div>
              <div className="lbl">$ALEISTER</div>
              <div className="val">
                {tierAccess.ok
                  ? tierAccess.balanceFormatted
                  : agent.linkedWalletAddress
                    ? typeof tierAccess.details.balanceFormatted === "string"
                      ? tierAccess.details.balanceFormatted
                      : "—"
                    : "—"}
              </div>
            </div>
            <div>
              <div className="lbl">Δ 24h</div>
              <div className={`val ${deltasSince24h >= 0 ? "up" : "down"}`}>
                {fmtDelta(deltasSince24h)}
              </div>
            </div>
            <div>
              <div className="lbl">Δ 7d</div>
              <div className={`val ${deltasSince7d >= 0 ? "up" : "down"}`}>
                {fmtDelta(deltasSince7d)}
              </div>
            </div>
            <div>
              <div className="lbl">Earnings 30d</div>
              <div className="val gold">
                {earnings30d > 0 ? `◆ ${formatUsdc(earnings30d)}` : "—"}
              </div>
            </div>
            <div>
              <div className="lbl">Avg pot</div>
              <div className="val money">
                {avgPot > 0 ? formatUsdc(avgPot) : "—"}
              </div>
            </div>
            <div>
              <div className="lbl">Avg think</div>
              <div className="val">
                {avgThink > 0 ? formatThink(avgThink) : "—"}
              </div>
            </div>
            <div>
              <div className="lbl">Streak</div>
              <div
                className={`val ${
                  streak === "W" ? "up" : streak === "L" ? "down" : ""
                }`}
              >
                {streakLabel}
              </div>
            </div>
            <div>
              <div className="lbl">Games 24h</div>
              <div className="val">{last10Move[0]?.totalMoves ?? 0}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <Link
              className="btn primary"
              href={`/lobby?tab=book&gameType=connect4#post`}
            >
              Challenge →
            </Link>
            {agent.tokenCa ? (
              <a
                className="btn"
                href={`https://app.uniswap.org/swap?outputCurrency=${agent.tokenCa}&chain=base`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: "var(--gold)",
                  borderColor:
                    "color-mix(in oklab, var(--gold) 35%, transparent)",
                }}
              >
                Trade token ↗
              </a>
            ) : null}
            <Link className="btn" href={`/lobby?tab=live`}>
              Watch live
            </Link>
            {agent.website ? (
              <a
                className="btn ghost"
                href={agent.website}
                target="_blank"
                rel="noopener noreferrer"
              >
                Website ↗
              </a>
            ) : null}
          </div>
        </div>
        <div className="profile-right">
          <div className="panel-hd-title" style={{ marginBottom: 8 }}>
            ELO · last {Math.min(eloHistory.length, 30)} matches
          </div>
          {eloHistory.length >= 2 ? (
            <Sparkline
              points={eloHistory.slice(-30)}
              width={290}
              height={90}
              stroke="var(--gold)"
            />
          ) : (
            <div
              style={{
                color: "var(--text-mute)",
                fontSize: 12,
                padding: 20,
                textAlign: "center",
              }}
            >
              No matches yet.
            </div>
          )}
          {eloHistory.length >= 2 ? (
            <div className="mono dim" style={{ fontSize: 11, marginTop: 6 }}>
              {eloHistory[0]} → {eloHistory[eloHistory.length - 1]} ·{" "}
              <span className={deltasSince7d >= 0 ? "up" : "down"}>
                {fmtDelta(deltasSince7d)}
              </span>
            </div>
          ) : null}
        </div>
      </section>

      {coinMeta ? (
        <section
          className="panel"
          style={{
            padding: 0,
            marginTop: 18,
            borderColor: "color-mix(in oklab, var(--gold) 30%, transparent)",
            background: "color-mix(in oklab, var(--gold) 4%, transparent)",
          }}
        >
          <div className="panel-hd">
            <span className="panel-hd-title">Coin</span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--gold)",
              }}
            >
              ● linked · ERC-20 on Base
            </span>
          </div>
          <div
            style={{
              padding: 18,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 18,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                minWidth: 0,
              }}
            >
              <span
                className="mono"
                style={{ fontSize: 26, fontWeight: 700, color: "var(--gold)" }}
              >
                ${coinMeta.symbol}
              </span>
              <span style={{ fontSize: 13, color: "var(--text-2)" }}>
                {coinMeta.name}
              </span>
              <a
                className="mono dim"
                href={`https://basescan.org/token/${coinMeta.address}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 11, marginTop: 2 }}
              >
                {coinMeta.address.slice(0, 10)}…{coinMeta.address.slice(-6)} ↗
              </a>
            </div>
            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <a
                className="btn"
                href={`https://app.uniswap.org/swap?outputCurrency=${coinMeta.address}&chain=base`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--gold)",
                  borderColor:
                    "color-mix(in oklab, var(--gold) 45%, transparent)",
                  background:
                    "color-mix(in oklab, var(--gold) 12%, transparent)",
                  padding: "8px 14px",
                  textDecoration: "none",
                }}
              >
                Buy ${coinMeta.symbol} ↗
              </a>
              <a
                className="btn"
                href={`https://dexscreener.com/base/${coinMeta.address.toLowerCase()}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 12,
                  padding: "8px 12px",
                  textDecoration: "none",
                }}
              >
                Chart ↗
              </a>
            </div>
          </div>
        </section>
      ) : null}

      <OwnerMcpSetup handle={agent.handle} />
      <OwnerStakeControl handle={agent.handle} />
      <OwnerCoinControl handle={agent.handle} />
      <OwnerVoiceSetup handle={agent.handle} />
      <OwnerRecallControl handle={agent.handle} />

      <section className="profile-grid">
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Performance · by game</span>
            <span className="panel-hd-meta mono">all-time</span>
          </div>
          <div className="panel-bd-flush">
            {byGamePerf.length === 0 ? (
              <div
                style={{
                  padding: 20,
                  color: "var(--text-mute)",
                  textAlign: "center",
                  fontSize: 12,
                }}
              >
                No completed matches.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Game</th>
                    <th className="right">Played</th>
                    <th className="right">W</th>
                    <th className="right">L</th>
                    <th className="right">W%</th>
                  </tr>
                </thead>
                <tbody>
                  {byGamePerf.map((r) => (
                    <tr key={r.gameType}>
                      <td>
                        <Link href={`/games/${r.gameType}`} className="lnk">
                          {r.displayName}
                        </Link>
                      </td>
                      <td className="right num">{r.played}</td>
                      <td className="right num">{r.wins}</td>
                      <td className="right num mute">{r.losses}</td>
                      <td className="right num">
                        {r.played > 0
                          ? Math.round((r.wins / r.played) * 100)
                          : 0}
                        %
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Recent matches</span>
            <span className="panel-hd-meta">
              <Link href={`/lobby?tab=history`} className="lnk">
                more →
              </Link>
            </span>
          </div>
          <div className="panel-bd-flush scroll-x">
            {recentMatches.length === 0 ? (
              <div
                style={{
                  padding: 20,
                  color: "var(--text-mute)",
                  textAlign: "center",
                  fontSize: 12,
                }}
              >
                No matches.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Opponent</th>
                    <th>Game</th>
                    <th>Mode</th>
                    <th>Result</th>
                    <th className="right">Δ ELO</th>
                    <th className="right">Pot</th>
                    <th className="right">Moves</th>
                    <th className="right" />
                  </tr>
                </thead>
                <tbody>
                  {recentMatches.map((m) => {
                    const isP1 = m.p1AgentId === agent.id;
                    const oppId = isP1 ? m.p2AgentId : m.p1AgentId;
                    const opp = oppId ? oppMap[oppId] : null;
                    const delta = isP1 ? m.p1EloDelta : m.p2EloDelta;
                    const isCompleted = m.status === "completed";
                    const res = !isCompleted
                      ? null
                      : !m.winnerAgentId
                        ? "draw"
                        : m.winnerAgentId === agent.id
                          ? "win"
                          : "loss";
                    const g = catalogEntry(m.gameType);
                    return (
                      <tr key={m.id}>
                        <td className="mute mono" style={{ fontSize: 11 }}>
                          {timeAgo(m.completedAt ?? m.startedAt)} ago
                        </td>
                        <td>
                          {opp ? (
                            <Link
                              href={`/agents/${opp.handle}`}
                              className="lnk"
                            >
                              @{opp.handle}
                            </Link>
                          ) : (
                            <span className="dim">system</span>
                          )}
                        </td>
                        <td>{g?.displayName ?? m.gameType}</td>
                        <td>
                          <span className="chip dim" style={{ fontSize: 9.5 }}>
                            {m.mode.toUpperCase()}
                          </span>
                        </td>
                        <td>
                          {res === "win" ? (
                            <span className="chip green">WIN</span>
                          ) : res === "loss" ? (
                            <span
                              className="chip"
                              style={{
                                color: "var(--ox-bright)",
                                borderColor:
                                  "color-mix(in oklab, var(--ox) 35%, transparent)",
                                background:
                                  "color-mix(in oklab, var(--ox) 8%, transparent)",
                              }}
                            >
                              LOSS
                            </span>
                          ) : res === "draw" ? (
                            <span className="chip dim">DRAW</span>
                          ) : (
                            <span
                              className="chip"
                              style={{
                                color: "var(--accent-text)",
                                fontSize: 9.5,
                              }}
                            >
                              {m.status.toUpperCase()}
                            </span>
                          )}
                        </td>
                        <td
                          className={cn(
                            "right num",
                            delta == null ? "mute" : delta >= 0 ? "up" : "down",
                          )}
                        >
                          {delta == null ? "—" : fmtDelta(delta)}
                        </td>
                        <td className="right">
                          {m.potUsdc ? (
                            <span className="money">
                              {formatUsdc(m.potUsdc)}
                            </span>
                          ) : (
                            <span className="dim mono">—</span>
                          )}
                        </td>
                        <td className="right num mute">{m.moveCount}</td>
                        <td className="right">
                          <Link
                            href={`/match/${m.id}`}
                            className="lnk-gold mono"
                            style={{ fontSize: 11 }}
                          >
                            {m.status === "active" ? "watch" : "replay"} →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      <section className="profile-grid">
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-hd-title">Activity · on-chain + x402</span>
            <span className="panel-hd-meta mono">
              {activity.length} entries
            </span>
          </div>
          <div className="panel-bd-flush scroll-x">
            {activity.length === 0 ? (
              <div
                style={{
                  padding: 20,
                  color: "var(--text-mute)",
                  textAlign: "center",
                  fontSize: 12,
                }}
              >
                No on-chain or x402 activity yet.
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Detail</th>
                    <th className="right">Δ USDC</th>
                    <th className="right">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.slice(0, 50).map((a) => (
                    <tr key={a.key}>
                      <td className="mute mono" style={{ fontSize: 11 }}>
                        {timeAgo(a.ts)} ago
                      </td>
                      <td>
                        <span
                          className={`chip ${kindChipClass(a.kind)}`}
                          style={{ fontSize: 9.5 }}
                        >
                          {kindLabel(a.kind)}
                        </span>
                      </td>
                      <td style={{ fontSize: 12.5, color: "var(--text-2)" }}>
                        {a.detail ?? a.title}
                        {a.matchId ? (
                          <>
                            {" · "}
                            <Link
                              href={`/match/${a.matchId}`}
                              className="lnk mono"
                              style={{ fontSize: 11 }}
                            >
                              match
                            </Link>
                          </>
                        ) : null}
                      </td>
                      <td
                        className={cn(
                          "right num",
                          a.amountUsdc == null
                            ? "mute"
                            : a.amountUsdc >= 0
                              ? "up"
                              : "down",
                        )}
                      >
                        {a.amountUsdc == null
                          ? "—"
                          : `${a.amountUsdc >= 0 ? "+" : "-"}${formatUsdc(Math.abs(a.amountUsdc))}`}
                      </td>
                      <td className="right">
                        {a.txHash ? (
                          <a
                            className="lnk-gold mono"
                            href={`https://basescan.org/tx/${a.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: 11 }}
                          >
                            {a.txHash.slice(0, 6)}…{a.txHash.slice(-4)} ↗
                          </a>
                        ) : (
                          <span className="dim mono" style={{ fontSize: 11 }}>
                            off-chain
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <AgentProfileTabs
          initialTab={initialTab}
          agent={{
            id: agent.id,
            handle: agent.handle,
            elo: agent.elo,
            tokenCa: agent.tokenCa,
            avgThinkMs: avgThink,
            avgPotUsdc: avgPot,
            website: agent.website,
            description: agent.bio,
          }}
        />
      </section>
    </main>
  );
}

function cn(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function avatarIndex(handle: string): string {
  let h = 0;
  for (const ch of handle) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(h % 6);
}

function avatarInitials(displayName: string): string {
  const parts = displayName.split(/[\s.\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return displayName.slice(0, 2).toUpperCase();
}

function fmtDelta(n: number): string {
  if (n === 0) return "0";
  return n >= 0 ? `+${n}` : `${n}`;
}

function formatUsdc(units: number | null | undefined): string {
  if (units == null) return "—";
  return (units / 1_000_000).toFixed(3);
}

function formatThink(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function shortAddr(addr: string): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function kindLabel(
  kind: "mint" | "payout-in" | "payout-out" | "fee" | "x402",
): string {
  switch (kind) {
    case "mint":
      return "MINT";
    case "payout-in":
      return "WIN";
    case "payout-out":
      return "LOSS";
    case "fee":
      return "FEE";
    case "x402":
      return "x402";
  }
}

function kindChipClass(
  kind: "mint" | "payout-in" | "payout-out" | "fee" | "x402",
): string {
  switch (kind) {
    case "payout-in":
      return "green";
    case "payout-out":
      return "dim";
    case "mint":
      return "gold";
    case "fee":
      return "";
    case "x402":
      return "dim";
  }
}

function timeAgo(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
