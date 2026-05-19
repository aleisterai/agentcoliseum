/**
 * GET /api/feed
 *
 * Canonical global activity stream for the platform. Merges several
 * event sources into a single time-sorted feed:
 *   - match_completed   — a paid/free match just settled with a winner
 *   - big_payout        — match with pot ≥ $5 USDC settled
 *   - agent_recalled    — operator / owner / system imposed a pause
 *   - new_agent         — fresh agent registered (mint)
 *   - coin_linked       — agent bound a tokenCa to its profile
 *
 * Used by:
 *   - Homepage <ActivityFeed/> ticker / marquee
 *   - Mention bots (future) that need raw event data to repost
 *   - Frame backends fetching the latest moment to share
 *
 * Cached 5s public + 10s s-maxage so CDN takes most reads. Returns
 * up to 50 events. Each event ships with a `href` pointer for the UI.
 */
import { NextResponse } from "next/server";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, matches } from "@/lib/db/schema";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

const FEED_LIMIT = 50;
const WINDOW_DAYS = 7; // only events in the last week
const BIG_PAYOUT_THRESHOLD_USDC = 5_000_000; // $5

type FeedEvent =
  | {
      kind: "match_completed";
      ts: string;
      winnerHandle: string | null;
      winnerDisplayName: string | null;
      loserHandle: string | null;
      gameType: string;
      potUsdc: number | null;
      matchId: string;
      href: string;
    }
  | {
      kind: "big_payout";
      ts: string;
      winnerHandle: string | null;
      gameType: string;
      potUsdc: number;
      matchId: string;
      href: string;
    }
  | {
      kind: "agent_recalled";
      ts: string;
      handle: string;
      recalledBy: "owner" | "operator" | "system";
      reason: string | null;
      href: string;
    }
  | {
      kind: "new_agent";
      ts: string;
      handle: string;
      displayName: string;
      href: string;
    }
  | {
      kind: "coin_linked";
      ts: string;
      handle: string;
      tokenCa: string;
      href: string;
    };

export async function GET() {
  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [completedRows, recalledRows, newAgentRows, coinAgentRows] =
      await Promise.all([
        db
          .select({
            id: matches.id,
            gameType: matches.gameType,
            mode: matches.mode,
            potUsdc: matches.potUsdc,
            winnerAgentId: matches.winnerAgentId,
            p1AgentId: matches.p1AgentId,
            p2AgentId: matches.p2AgentId,
            completedAt: matches.completedAt,
          })
          .from(matches)
          .where(
            and(
              eq(matches.status, "completed"),
              isNotNull(matches.completedAt),
              gte(matches.completedAt, since),
            ),
          )
          .orderBy(desc(matches.completedAt))
          .limit(30),
        db
          .select({
            id: agents.id,
            handle: agents.handle,
            recalledAt: agents.recalledAt,
            recalledBy: agents.recalledBy,
            recallReason: agents.recallReason,
          })
          .from(agents)
          .where(
            and(
              isNotNull(agents.recalledAt),
              gte(agents.recalledAt, since),
            ),
          )
          .orderBy(desc(agents.recalledAt))
          .limit(20),
        db
          .select({
            id: agents.id,
            handle: agents.handle,
            displayName: agents.displayName,
            createdAt: agents.createdAt,
          })
          .from(agents)
          .where(gte(agents.createdAt, since))
          .orderBy(desc(agents.createdAt))
          .limit(20),
        // Coin-linked events: agents with tokenCa set + a recent createdAt
        // (rough proxy — there's no audit log of the link moment in v1).
        // Future hardening: add an agent_audit_log with explicit "tokenCa
        // set" rows so we can show the exact timestamp of the link.
        db
          .select({
            id: agents.id,
            handle: agents.handle,
            tokenCa: agents.tokenCa,
            createdAt: agents.createdAt,
          })
          .from(agents)
          .where(
            and(
              isNotNull(agents.tokenCa),
              gte(agents.createdAt, since),
            ),
          )
          .orderBy(desc(agents.createdAt))
          .limit(20),
      ]);

    // Resolve handles for all agent IDs referenced by completed-match rows.
    const matchAgentIds = new Set<string>();
    for (const m of completedRows) {
      if (m.winnerAgentId) matchAgentIds.add(m.winnerAgentId);
      if (m.p1AgentId) matchAgentIds.add(m.p1AgentId);
      if (m.p2AgentId) matchAgentIds.add(m.p2AgentId);
    }
    const handleMap = new Map<
      string,
      { handle: string; displayName: string }
    >();
    if (matchAgentIds.size > 0) {
      const rows = await db
        .select({
          id: agents.id,
          handle: agents.handle,
          displayName: agents.displayName,
        })
        .from(agents)
        .where(
          sql`${agents.id} IN (${sql.join(
            [...matchAgentIds].map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
      for (const r of rows)
        handleMap.set(r.id, { handle: r.handle, displayName: r.displayName });
    }

    const events: FeedEvent[] = [];

    for (const m of completedRows) {
      const winnerInfo = m.winnerAgentId ? handleMap.get(m.winnerAgentId) : null;
      const loserId =
        m.winnerAgentId && m.p1AgentId === m.winnerAgentId
          ? m.p2AgentId
          : m.p1AgentId;
      const loserInfo = loserId ? handleMap.get(loserId) : null;
      const ts = m.completedAt!.toISOString();
      const href = `/match/${m.id}`;
      events.push({
        kind: "match_completed",
        ts,
        winnerHandle: winnerInfo?.handle ?? null,
        winnerDisplayName: winnerInfo?.displayName ?? null,
        loserHandle: loserInfo?.handle ?? null,
        gameType: m.gameType,
        potUsdc: m.potUsdc,
        matchId: m.id,
        href,
      });
      if (m.potUsdc != null && m.potUsdc >= BIG_PAYOUT_THRESHOLD_USDC) {
        events.push({
          kind: "big_payout",
          ts,
          winnerHandle: winnerInfo?.handle ?? null,
          gameType: m.gameType,
          potUsdc: m.potUsdc,
          matchId: m.id,
          href,
        });
      }
    }

    for (const r of recalledRows) {
      events.push({
        kind: "agent_recalled",
        ts: r.recalledAt!.toISOString(),
        handle: r.handle,
        recalledBy: (r.recalledBy ?? "system") as
          | "owner"
          | "operator"
          | "system",
        reason: r.recallReason,
        href: `/agents/${r.handle}`,
      });
    }

    for (const a of newAgentRows) {
      events.push({
        kind: "new_agent",
        ts: a.createdAt.toISOString(),
        handle: a.handle,
        displayName: a.displayName,
        href: `/agents/${a.handle}`,
      });
    }

    for (const a of coinAgentRows) {
      if (!a.tokenCa) continue;
      events.push({
        kind: "coin_linked",
        ts: a.createdAt.toISOString(),
        handle: a.handle,
        tokenCa: a.tokenCa,
        href: `/agents/${a.handle}`,
      });
    }

    events.sort((x, y) => y.ts.localeCompare(x.ts));
    const top = events.slice(0, FEED_LIMIT);

    return NextResponse.json(
      {
        events: top,
        sampledAt: new Date().toISOString(),
        windowDays: WINDOW_DAYS,
        bigPayoutThresholdUsdc: BIG_PAYOUT_THRESHOLD_USDC,
      },
      {
        headers: {
          // 5s edge, 10s CDN. The CDN cache is what keeps the homepage
          // marquee snappy for everyone after a single warm-up read.
          "Cache-Control": "public, max-age=5, s-maxage=10",
        },
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
