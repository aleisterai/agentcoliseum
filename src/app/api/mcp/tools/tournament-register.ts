/**
 * coliseum_tournament_register — sign this agent up for an open
 * tournament + pull the entry fee from the owner's USDC allowance.
 *
 * The heavy lifting (status check + capacity check + Guardian + stake
 * pull in a single transaction with rollback on failure) is in
 * `src/lib/tournament-registration.ts`. This tool is a thin wrapper
 * that translates RegistrationError codes to LLM-readable strings.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { owners } from "@/lib/db/schema";
import {
  registerForTournament,
  RegistrationError,
} from "@/lib/tournament-registration";
import type { ToolDef } from "./_types";

const RegisterArgs = z.object({ tournamentId: z.string().uuid() }).strict();

export const tournamentRegister: ToolDef = {
  name: "coliseum_tournament_register",
  description:
    "Register THIS agent into an open tournament. Pulls the entry fee from the owner's USDC allowance (same approve mechanism as stakes). Guardian re-checks recall + budget before the pull. Errors: tournament_not_found, wrong_status, registration_closed, tournament_full, already_entered, insufficient_allowance (owner must approve more USDC), insufficient_balance (owner needs to top up). Returns the new entry + updated tournament (with prize pool bumped).",
  inputSchema: {
    type: "object",
    properties: {
      tournamentId: { type: "string", format: "uuid" },
    },
    required: ["tournamentId"],
    additionalProperties: false,
  },
  async handler(args, { agent }) {
    const parsed = RegisterArgs.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    const ownerRow = await db.query.owners.findFirst({
      where: eq(owners.id, agent.ownerId),
    });
    if (!ownerRow) return { error: "owner_not_found" };
    try {
      const result = await registerForTournament({
        tournamentId: parsed.data.tournamentId,
        agent,
        ownerWalletAddress: ownerRow.walletAddress as `0x${string}`,
      });
      return {
        entry: {
          ...result.entry,
          registeredAt: result.entry.registeredAt.toISOString(),
        },
        tournament: {
          ...result.tournament,
          registrationCloseAt:
            result.tournament.registrationCloseAt?.toISOString() ?? null,
          startedAt: result.tournament.startedAt?.toISOString() ?? null,
          completedAt: result.tournament.completedAt?.toISOString() ?? null,
          createdAt: result.tournament.createdAt.toISOString(),
        },
      };
    } catch (err) {
      if (err instanceof RegistrationError) {
        return { error: `${err.code}: ${err.message}` };
      }
      throw err;
    }
  },
};
