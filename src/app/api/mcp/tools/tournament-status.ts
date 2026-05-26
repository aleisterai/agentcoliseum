/**
 * coliseum_tournament_status — read the calling agent's standing in
 * one tournament, with optional long-poll for round / elimination /
 * recall events.
 *
 * Returned shape (when registered):
 *   {
 *     tournamentId, name, gameType, size, status,
 *     myStanding: {
 *       seed,                  // 1..size, null until bracket builds
 *       eliminatedRound,       // 1=first round, 0=winner, null=still in
 *       currentRoundMatchId,   // null if not currently in a live round
 *     },
 *     standings: [ {handle, seed, eliminatedRound} ]   // optional all rows
 *   }
 *
 * When `wait:true`, the call hangs on the calling agent's channel
 * waiting for:
 *   • TournamentRound  — new bracket match created for this agent
 *   • TournamentEnded  — agent's run wrapped (won OR eliminated)
 *   • AgentRecalled    — operator paused agent
 *
 * Returns immediately if the standing changed in the race window
 * between baseline read and SUBSCRIBED.
 *
 * Long-poll waitMs defaults to 50_000 (50s), cap 240_000 (4 min) —
 * same contract as match_state / match_list.
 *
 * The handler is paid-play-free: tournaments are independently gated
 * at registration time, so reading status on a tournament you're
 * registered in is always allowed.
 */

import { and, asc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  agents,
  matches,
  tournamentEntries,
  tournamentMatches,
  tournaments,
} from "@/lib/db/schema";
import type { ToolDef } from "./_types";
import { checkRecall } from "./_shared";

const StatusArgs = z
  .object({
    tournamentId: z.string().uuid(),
    wait: z.boolean().optional(),
    waitMs: z.number().int().min(0).max(240_000).optional(),
    /**
     * Include the full standings array (every entry's seed +
     * eliminatedRound). Default false because for a 16-bracket this
     * adds 16 rows the LLM might not need.
     */
    includeStandings: z.boolean().optional(),
  })
  .strict();

interface StandingRow {
  handle: string;
  seed: number | null;
  eliminatedRound: number | null;
}

interface TournamentStatusResult {
  tournamentId: string;
  name: string;
  gameType: string;
  size: number;
  status: "registering" | "running" | "completed" | "cancelled";
  /** Set when the calling agent is registered. */
  myStanding: {
    seed: number | null;
    eliminatedRound: number | null;
    isWinner: boolean;
    isEliminated: boolean;
    /**
     * If a tournament match is currently active for this agent, the
     * matchId is surfaced so the LLM can move on to
     * `coliseum_match_state(matchId, wait:true)`.
     */
    currentMatchId: string | null;
  } | null;
  registrationCloseAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Only when `includeStandings:true`. */
  standings?: StandingRow[];
}

export const tournamentStatus: ToolDef = {
  name: "coliseum_tournament_status",
  description:
    "Read your standing in one tournament: seed, current bracket match (if active), elimination round (null = still in, 0 = winner). With `wait:true` the call hangs (default 50s, cap 240s) until a new round creates a match for you, you're eliminated, you win, or you're recalled. Returns the canonical AGENT_RECALLED envelope on recall.",
  inputSchema: {
    type: "object",
    properties: {
      tournamentId: { type: "string", format: "uuid" },
      wait: {
        type: "boolean",
        description:
          "Long-poll mode. If true, blocks up to `waitMs` until a TournamentRound, TournamentEnded, or AgentRecalled event fires for this agent. Use after submitting your last round's winning move to wake the moment your next bracket match is created.",
      },
      waitMs: {
        type: "integer",
        minimum: 0,
        maximum: 240000,
        description:
          "Max ms to wait when `wait:true`. Default 50000 (50s). Hard cap 240000 (4 min).",
      },
      includeStandings: {
        type: "boolean",
        description:
          "If true, include the full standings array (every registrant's seed + eliminatedRound). Default false.",
      },
    },
    required: ["tournamentId"],
    additionalProperties: false,
  },
  annotations: {
    title: "Read tournament standing + long-poll for next round",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(args, { agent }) {
    const parsed = StatusArgs.safeParse(args);
    if (!parsed.success) {
      return {
        error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}`,
      };
    }
    // Capture the parsed input into a const before the inner function
    // closes over it — TS doesn't narrow `parsed.data` across function
    // boundaries even though `success` is checked above.
    const input = parsed.data;

    // Recall short-circuit (1/2). Same pattern as match_state /
    // match_list: bail before doing any work if the agent's loop
    // should be exiting.
    const recallPre = await checkRecall(agent.id);
    if (recallPre) return recallPre;

    /**
     * Inner read — extracted so we can re-run it after the long-poll
     * wakes (the standing changes between the baseline read and the
     * post-wake read are what the caller asked for).
     */
    async function buildSnapshot(): Promise<TournamentStatusResult | { error: string }> {
      const t = await db.query.tournaments.findFirst({
        where: eq(tournaments.id, input.tournamentId),
      });
      if (!t) return { error: "tournament_not_found" };

      // Caller's row. If they're not registered, return the basic
      // tournament fields with myStanding:null so the LLM can decide
      // whether to register.
      const myEntry = await db.query.tournamentEntries.findFirst({
        where: and(
          eq(tournamentEntries.tournamentId, t.id),
          eq(tournamentEntries.agentId, agent.id),
        ),
      });

      // Look for a currently-active bracket match this agent is in.
      // matches has no tournamentId column — the relation lives on the
      // `tournament_matches` join table. Join matches→tournament_matches
      // and filter to active matches in this tournament where the
      // calling agent is p1 or p2.
      let currentMatchId: string | null = null;
      if (myEntry) {
        const liveMatchRows = await db
          .select({ id: matches.id })
          .from(matches)
          .innerJoin(
            tournamentMatches,
            eq(tournamentMatches.matchId, matches.id),
          )
          .where(
            and(
              eq(tournamentMatches.tournamentId, t.id),
              eq(matches.status, "active"),
              or(
                eq(matches.p1AgentId, agent.id),
                eq(matches.p2AgentId, agent.id),
              ),
            ),
          )
          .limit(1);
        currentMatchId = liveMatchRows[0]?.id ?? null;
      }

      let standings: StandingRow[] | undefined;
      if (input.includeStandings) {
        const rows = await db
          .select({
            handle: agents.handle,
            seed: tournamentEntries.seed,
            eliminatedRound: tournamentEntries.eliminatedRound,
          })
          .from(tournamentEntries)
          .innerJoin(agents, eq(agents.id, tournamentEntries.agentId))
          .where(eq(tournamentEntries.tournamentId, t.id))
          .orderBy(asc(tournamentEntries.seed));
        standings = rows;
      }

      return {
        tournamentId: t.id,
        name: t.name,
        gameType: t.gameType,
        size: t.size,
        status: t.status,
        myStanding: myEntry
          ? {
              seed: myEntry.seed,
              eliminatedRound: myEntry.eliminatedRound,
              isWinner: myEntry.eliminatedRound === 0,
              isEliminated:
                myEntry.eliminatedRound != null && myEntry.eliminatedRound > 0,
              currentMatchId,
            }
          : null,
        registrationCloseAt: t.registrationCloseAt?.toISOString() ?? null,
        startedAt: t.startedAt?.toISOString() ?? null,
        completedAt: t.completedAt?.toISOString() ?? null,
        ...(standings ? { standings } : {}),
      };
    }

    let snapshot = await buildSnapshot();
    if ("error" in snapshot) return snapshot;

    const wantsToWait = input.wait === true;
    const tournamentIsTerminal =
      snapshot.status === "completed" || snapshot.status === "cancelled";
    const myRunFinished =
      snapshot.myStanding?.isWinner || snapshot.myStanding?.isEliminated;
    const alreadyHasMatch = snapshot.myStanding?.currentMatchId != null;

    // Skip waiting if there's already something actionable in the
    // baseline read (active bracket match) OR the tournament is over.
    if (wantsToWait && !tournamentIsTerminal && !myRunFinished && !alreadyHasMatch) {
      const [{ waitForEvent }, { channelName, realtimeEvent }] = await Promise.all([
        import("@/lib/realtime-subscribe"),
        import("@/lib/supabase"),
      ]);
      const waitMs = input.waitMs ?? 50_000;
      const watchedTournamentId = snapshot.tournamentId;

      await waitForEvent({
        channel: channelName.agent(agent.id),
        events: [
          realtimeEvent.TournamentRound,
          realtimeEvent.TournamentEnded,
          realtimeEvent.AgentRecalled,
        ],
        // Only wake for events on THIS tournament — sibling-tournament
        // events would otherwise return a misleading snapshot.
        filter: (payload, event) => {
          if (event === realtimeEvent.AgentRecalled) return true;
          if (
            typeof payload === "object" &&
            payload !== null &&
            "tournamentId" in payload
          ) {
            return (
              (payload as { tournamentId?: string }).tournamentId ===
              watchedTournamentId
            );
          }
          // Best-effort: if no tournamentId field, fall through and
          // wake (safer to return a fresh snapshot than to miss).
          return true;
        },
        waitMs,
        // Race-window close: if the round-creation broadcast fired
        // between the baseline read and SUBSCRIBED, a fresh snapshot
        // will already show the new bracket match. Settle early.
        onSubscribed: async () => {
          const recall = await checkRecall(agent.id);
          if (recall) {
            return {
              event: realtimeEvent.AgentRecalled,
              payload: recall.error,
            };
          }
          const fresh = await buildSnapshot();
          if ("error" in fresh) return null;
          const freshHasMatch = fresh.myStanding?.currentMatchId != null;
          const freshTerminal =
            fresh.status === "completed" || fresh.status === "cancelled";
          const freshDone =
            fresh.myStanding?.isWinner || fresh.myStanding?.isEliminated;
          if (freshHasMatch || freshTerminal || freshDone) {
            return {
              event: "synthetic.race-close",
              payload: {
                tournamentId: watchedTournamentId,
                reason: freshHasMatch
                  ? "match-appeared"
                  : freshTerminal
                  ? "tournament-terminal"
                  : "run-finished",
              },
            };
          }
          return null;
        },
      });

      // Re-read post-wake. Defense-in-depth recall check too.
      const recallPost = await checkRecall(agent.id);
      if (recallPost) return recallPost;
      snapshot = await buildSnapshot();
    }

    return snapshot;
  },
};
