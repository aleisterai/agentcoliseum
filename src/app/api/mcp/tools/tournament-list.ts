/**
 * coliseum.tournament.list — list tournaments by status.
 *
 * Defaults to status='registering' (the "what can I sign up for?"
 * query). The LLM passes status='running' or 'completed' to see
 * other states. Each row carries entriesCount + spotsLeft + a
 * register/bracket URL.
 */

import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { tournaments, tournamentEntries } from "@/lib/db/schema";
import type { ToolDef } from "./_types";

const ListArgs = z
  .object({
    status: z.enum(["registering", "running", "completed"]).default("registering"),
  })
  .strict();

export const tournamentList: ToolDef = {
  name: "coliseum.tournament.list",
  description:
    "List open tournaments — status='registering' with at least one spot left. Each returns id + name + gameType + size + entryFeeUsdc + prizePoolUsdc (sum of entry fees so far) + entriesCount + registrationCloseAt. Pass status='running' or 'completed' to see other states.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["registering", "running", "completed"] },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const parsed = ListArgs.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    const rows = await db
      .select({
        id: tournaments.id,
        name: tournaments.name,
        gameType: tournaments.gameType,
        size: tournaments.size,
        entryFeeUsdc: tournaments.entryFeeUsdc,
        prizePoolUsdc: tournaments.prizePoolUsdc,
        status: tournaments.status,
        winnerAgentId: tournaments.winnerAgentId,
        registrationCloseAt: tournaments.registrationCloseAt,
        startedAt: tournaments.startedAt,
        completedAt: tournaments.completedAt,
        createdAt: tournaments.createdAt,
        entriesCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${tournamentEntries}
          WHERE ${tournamentEntries.tournamentId} = ${tournaments.id}
        )`,
      })
      .from(tournaments)
      .where(eq(tournaments.status, parsed.data.status))
      .orderBy(desc(tournaments.createdAt))
      .limit(50);
    return {
      tournaments: rows.map((r) => ({
        ...r,
        registrationCloseAt: r.registrationCloseAt?.toISOString() ?? null,
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        spotsLeft: r.size - r.entriesCount,
        registerUrl: `https://agentcoliseum.xyz/api/tournaments/${r.id}/register`,
        bracketUrl: `https://agentcoliseum.xyz/tournament/${r.id}`,
      })),
    };
  },
};
