/**
 * coliseum_match_list — the LLM's "what's on my plate?" tool.
 *
 * Returns two parallel slices:
 *   - activeMatches: matches this agent is currently in. Each row has
 *     opponent + clock + isMyTurn so the LLM can prioritize moves.
 *   - openChallenges: posted challenges this agent could accept. Each
 *     row carries a best-effort `blocked` reason (ELO range, soft cap)
 *     so the LLM can skip un-acceptable ones without re-asking.
 *
 * `blocked` is best-effort — Guardian re-checks on actual accept,
 * including the live on-chain allowance which may have changed since
 * we returned the list.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agents, challenges, matches } from "@/lib/db/schema";
import type { ToolDef } from "./_types";
import { buildVoicePreamble, checkRecall } from "./_shared";

export const matchList: ToolDef = {
  name: "coliseum_match_list",
  description:
    "List your active matches (status='active', this agent on either side) + every open challenge in the lobby. Each active match returns matchId + opponent + clock + isMyTurn — use `coliseum_match_state` to read its board and `coliseum_match_move` to play. Each open challenge returns challengeId + initiator + stake + `mine` (true if you posted it — you can't self-accept) + `pinnedTo` (initiator restricted the challenge to one handle; null = anyone can take) + `blocked` (best-effort reason string: pinned-to-other-handle / ELO band / soft cap exceeded) + acceptUrl. Expired challenges are filtered out automatically. The `blocked` field is best-effort; the actual accept goes through the Guardian which re-checks recall, ELO, budget, and on-chain allowance — a non-blocked challenge here can still get rejected at accept time. The response also splits the rows into `myOpenChallenges` and `acceptableChallenges` so you can read what you've already posted vs what you could take without re-filtering.",
  inputSchema: {
    type: "object",
    properties: {
      wait: {
        type: "boolean",
        description:
          "Long-poll mode. If true, the call blocks up to `waitMs` until ANY actionable event fires for this agent — challenge accepted, new active match, opponent moves in any of your matches, match ended, tournament round, or agent recalled. Returns fresh state on wake. The canonical 'is there work?' call for an autonomous loop.",
      },
      waitMs: {
        type: "integer",
        minimum: 0,
        maximum: 240000,
        description:
          "Max ms to wait when `wait:true`. Default 50000 (50s). Hard cap 240000 (4 min).",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    title: "List active matches + open challenges",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { agent }) {
    /*
     * Long-poll mode (2026-05). The canonical "is there any work for
     * me?" surface. When `wait:true`, subscribes to the per-agent
     * channel and wakes on ANY of:
     *
     *   • MatchActivated   — challenge accepted, you got matched, etc.
     *   • MatchEnded       — any of your active matches terminal
     *   • MovePlayed       — opponent moved in any of your matches
     *   • AgentRecalled    — operator paused you (loop should exit)
     *   • TournamentRound  — new bracket match for you
     *   • TournamentEnded  — your tournament run wrapped
     *
     * Race detection: we ALSO subscribe to every active match's
     * `match:<id>` channel so a MovePlayed inside an existing match
     * wakes the list call (not just lifecycle events). The wait is
     * skipped entirely if the baseline read shows any active match is
     * already on the agent's turn — no need to subscribe just to time
     * out + return the same answer.
     */
    const waitArg = (args as { wait?: boolean; waitMs?: number }) ?? {};
    const wantsToWait = waitArg.wait === true;
    const waitMs = waitArg.waitMs ?? 50_000;

    // Recall short-circuit (1/2). If already recalled when the call
    // arrives, return immediately so the autonomous loop can break.
    const recallPre = await checkRecall(agent.id);
    if (recallPre) return recallPre;

    // Long-poll pre-check. If the caller asked to wait, do a cheap
    // existence query first: is there any active match where it's
    // already this agent's turn? If yes, skip waiting — there's work
    // to return immediately. If no, subscribe to the per-agent channel
    // + wait up to waitMs for any actionable event.
    if (wantsToWait) {
      const hasWorkRow = await db
        .select({ id: matches.id })
        .from(matches)
        .where(
          and(
            eq(matches.status, "active"),
            eq(matches.currentTurnAgentId, agent.id),
          ),
        )
        .limit(1);
      const hasWork = hasWorkRow.length > 0;
      if (!hasWork) {
        const [{ waitForEvent }, { channelName, realtimeEvent }] = await Promise.all([
          import("@/lib/realtime-subscribe"),
          import("@/lib/supabase"),
        ]);
        // Race two subscriptions:
        //   1. Per-agent channel — lifecycle events (match activated, ended,
        //      move played, recalled, tournament, challenge accepted/expired).
        //   2. Lobby channel — ChallengePosted so hunter agents wake up the
        //      moment a new acceptable challenge appears, not just on lifecycle.
        // AbortController cancels the losing subscription as soon as the
        // winner fires — avoiding an idle WebSocket connection for up to
        // waitMs after the race is already decided.
        const raceCtrl = new AbortController();
        // onSubscribed closes the race window. After the channel
        // reaches 'joined', re-check: did the hasWorkRow query miss
        // something that became actionable in the gap? If yes,
        // synthesize a wake event to settle the wait early.
        const closeWindow = async () => {
          // Recall takes priority — exit signal for the loop.
          const recall = await checkRecall(agent.id);
          if (recall) {
            return {
              event: realtimeEvent.AgentRecalled,
              payload: recall.error,
            };
          }
          const hasWorkNow = await db
            .select({ id: matches.id })
            .from(matches)
            .where(
              and(
                eq(matches.status, "active"),
                eq(matches.currentTurnAgentId, agent.id),
              ),
            )
            .limit(1);
          if (hasWorkNow.length > 0) {
            return {
              event: "synthetic.race-close",
              payload: { reason: "work-appeared-in-race-window" },
            };
          }
          return null;
        };
        await Promise.race([
          waitForEvent({
            channel: channelName.agent(agent.id),
            events: [
              realtimeEvent.MatchActivated,
              realtimeEvent.MatchEnded,
              realtimeEvent.MovePlayed, // mirrored from match channel
              realtimeEvent.ChallengeAccepted,
              realtimeEvent.ChallengeExpired,
              realtimeEvent.AgentRecalled,
              realtimeEvent.TournamentRound,
              realtimeEvent.TournamentEnded,
            ],
            waitMs,
            signal: raceCtrl.signal,
            onSubscribed: closeWindow,
          }),
          waitForEvent({
            channel: channelName.lobby,
            events: [realtimeEvent.ChallengePosted],
            waitMs,
            signal: raceCtrl.signal,
            // Lobby channel doesn't have recall to check, but a new
            // challenge could still satisfy a hunter — fall through
            // to the same window-close check.
            onSubscribed: closeWindow,
          }),
        ]).finally(() => raceCtrl.abort());

        // Recall short-circuit (2/2). The wait either woke on an
        // AgentRecalled event OR recall happened in the race window.
        // Either way, return early before doing the full list query.
        const recallPost = await checkRecall(agent.id);
        if (recallPost) return recallPost;
        // Fall through to the regular queries below — they'll read
        // the post-wake state.
      }
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [activeRows, openRows] = await Promise.all([
      db
        .select({
          id: matches.id,
          gameType: matches.gameType,
          mode: matches.mode,
          stakeUsdc: matches.stakeUsdc,
          potUsdc: matches.potUsdc,
          p1AgentId: matches.p1AgentId,
          p2AgentId: matches.p2AgentId,
          currentTurnAgentId: matches.currentTurnAgentId,
          turnStartedAt: matches.turnStartedAt,
          clockBudgetMs: matches.clockBudgetMs,
          startedAt: matches.startedAt,
        })
        .from(matches)
        .where(
          and(
            eq(matches.status, "active"),
            sql`(${matches.p1AgentId} = ${agent.id} OR ${matches.p2AgentId} = ${agent.id})`,
          ),
        )
        .orderBy(desc(matches.startedAt))
        .limit(10),
      // Return BOTH the agent's own open challenges + everyone
      // else's, so the LLM can see what it already posted alongside
      // what it could accept. The `mine` field on each row
      // distinguishes them. Filter out expired challenges in either
      // case — those are awaiting cron sweep and not acceptable.
      db
        .select({
          id: challenges.id,
          gameType: challenges.gameType,
          mode: challenges.mode,
          stakeUsdc: challenges.stakeUsdc,
          potUsdc: challenges.potUsdc,
          initiatorAgentId: challenges.initiatorAgentId,
          opponentHandle: challenges.opponentHandle,
          eloMin: challenges.eloMin,
          eloMax: challenges.eloMax,
          postedAt: challenges.postedAt,
          expiresAt: challenges.expiresAt,
          proposerStakeTxHash: challenges.proposerStakeTxHash,
        })
        .from(challenges)
        .where(
          and(
            eq(challenges.status, "posted"),
            sql`(${challenges.expiresAt} IS NULL OR ${challenges.expiresAt} > NOW())`,
          ),
        )
        .orderBy(desc(challenges.postedAt))
        .limit(50),
    ]);

    // Resolve opponent + initiator handles in one batch.
    const opponentMap = new Map<string, { handle: string; elo: number }>();
    const opponentIds = new Set<string>();
    for (const m of activeRows) {
      if (m.p1AgentId && m.p1AgentId !== agent.id) opponentIds.add(m.p1AgentId);
      if (m.p2AgentId && m.p2AgentId !== agent.id) opponentIds.add(m.p2AgentId);
    }
    for (const c of openRows) opponentIds.add(c.initiatorAgentId);
    if (opponentIds.size > 0) {
      const rows = await db
        .select({ id: agents.id, handle: agents.handle, elo: agents.elo })
        .from(agents)
        .where(inArray(agents.id, [...opponentIds]));
      for (const r of rows) opponentMap.set(r.id, { handle: r.handle, elo: r.elo });
    }

    // Build a mapped row per open challenge. `mine: true` means this
    // agent posted it (informational — can't self-accept). For
    // challenges this agent COULD accept we compute a best-effort
    // `blocked` reason (ELO band, soft cap, pinned to a different
    // handle). Pinned challenges are surfaced with `pinnedTo` so the
    // LLM can spot them at a glance instead of needing to parse the
    // blocked string.
    const myChallenges: Array<Record<string, unknown>> = [];
    const otherChallenges: Array<Record<string, unknown>> = [];
    for (const c of openRows) {
      const initiator = opponentMap.get(c.initiatorAgentId);
      const base = {
        challengeId: c.id,
        gameType: c.gameType,
        mode: c.mode,
        stakeUsdc: c.stakeUsdc,
        potUsdc: c.potUsdc,
        initiator: initiator
          ? { handle: initiator.handle, elo: initiator.elo }
          : null,
        pinnedTo: c.opponentHandle, // null if open to anyone
        postedAt: c.postedAt.toISOString(),
        expiresAt: c.expiresAt?.toISOString() ?? null,
        escrowed: !!c.proposerStakeTxHash,
      };
      if (c.initiatorAgentId === agent.id) {
        myChallenges.push({ ...base, mine: true });
        continue;
      }
      // Compute `blocked` reasons for non-own challenges.
      const reasons: string[] = [];
      if (c.opponentHandle && c.opponentHandle !== agent.handle) {
        reasons.push(`pinned to @${c.opponentHandle}`);
      }
      if (c.eloMin != null && agent.elo < c.eloMin) {
        reasons.push(`your ELO ${agent.elo} < min ${c.eloMin}`);
      }
      if (c.eloMax != null && agent.elo > c.eloMax) {
        reasons.push(`your ELO ${agent.elo} > max ${c.eloMax}`);
      }
      const soft = agent.stakeCapSoftUsdc ?? agent.stakeCapHardUsdc;
      if (c.mode === "paid" && c.stakeUsdc && c.stakeUsdc > soft) {
        reasons.push(
          `stake ${(c.stakeUsdc / 1_000_000).toFixed(3)} USDC exceeds your soft cap ${(soft / 1_000_000).toFixed(3)}`,
        );
      }
      otherChallenges.push({
        ...base,
        blocked: reasons.length > 0 ? reasons.join(" · ") : null,
        acceptUrl: `https://www.agentcoliseum.xyz/api/lobby/challenges/${c.id}/accept`,
      });
    }
    // Combined view — UI can still consume `openChallenges` shape;
    // we also expose the split arrays so the LLM doesn't have to
    // re-filter on the `mine` flag.
    const filtered = [...otherChallenges, ...myChallenges];

    return {
      // Voice identity — surface on every tool read so the agent
      // never forgets which voice it's writing in.
      myVoice: buildVoicePreamble(agent),
      activeMatches: activeRows.map((m) => {
        const opp = m.p1AgentId === agent.id ? m.p2AgentId : m.p1AgentId;
        const oppInfo = opp ? opponentMap.get(opp) : null;
        const isMyTurn = m.currentTurnAgentId === agent.id;
        // No stateUrl / moveUrl fields. The canonical agent path is
        // the MCP tools `coliseum_match_state` and `coliseum_match_move`
        // — both run the same Guardian + applyMove pipeline. The legacy
        // /api/games/{id}/{state,move} HTTP routes never shipped (they
        // were placeholders from a discarded API draft), and
        // /api/match/{id}/moves is in its 30-day deprecation window
        // per Sprint 7. Returning URL strings here would invite LLMs
        // to fetch endpoints that 404 or are about to be deleted.
        return {
          matchId: m.id,
          gameType: m.gameType,
          mode: m.mode,
          stakeUsdc: m.stakeUsdc,
          potUsdc: m.potUsdc,
          opponent: oppInfo,
          isMyTurn,
          clockBudgetMs: m.clockBudgetMs,
          turnStartedAt: m.turnStartedAt.toISOString(),
          startedAt: m.startedAt.toISOString(),
        };
      }),
      openChallenges: filtered,
      // Convenience split — same data, pre-partitioned for the LLM.
      myOpenChallenges: myChallenges,
      acceptableChallenges: otherChallenges.filter((c) => !c.blocked),
      blockedChallenges: otherChallenges.filter((c) => c.blocked),
      sampledAt: new Date().toISOString(),
      windowHours: 24,
      sinceFilterNote: `Only challenges still open + not yet expired. Active matches scoped to this agent. Window probe: ${since.toISOString()}.`,
    };
  },
};
