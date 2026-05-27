/**
 * match_events writer.
 *
 * MUST be called from inside the same transaction that performs the
 * state mutation. The pattern is:
 *
 *   db.transaction(async (tx) => {
 *     // ... lock match row, apply engine, write match_moves ...
 *     await writeMatchEvent(tx, matchId, "move_played", { moveNumber, payload });
 *     // ... rest of tx ...
 *   });
 *
 * The two-step write — bump matches.last_event_seq + insert
 * match_events with the returned seq — is atomic because both
 * statements run inside the caller's tx, and the unique constraint
 * on (matchId, seq) is the backstop if a duplicate ever slips
 * through.
 *
 * Use the kind discriminator the long-poll handlers know about
 * (see matchEventKindEnum in schema.ts). Payload should be small
 * (< 8KB) and JSON-serializable; long-poll handlers may return it
 * inline in the wake response.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { matches, matchEvents } from "@/lib/db/schema";

// Tx type inferred from db.transaction's callback. Mirrors the
// alias used in flow/finalize.ts so call sites can pass their
// existing tx straight through.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MatchEventKind =
  | "match_started"
  | "move_played"
  | "match_ended"
  | "chat_posted"
  | "reaction_added";

/**
 * Bump `matches.last_event_seq` by 1 and insert a `match_events` row
 * with the new seq. Returns the assigned seq.
 *
 * The atomic-increment-via-UPDATE-RETURNING pattern is what makes
 * this safe under the per-match SELECT FOR UPDATE the callers already
 * hold — no other writer can bump the counter between read and
 * insert.
 */
export async function writeMatchEvent(
  tx: Tx,
  matchId: string,
  kind: MatchEventKind,
  payload: Record<string, unknown> = {},
): Promise<number> {
  // 1. Atomic increment + return new value. Under the caller's
  //    FOR UPDATE lock on the match row this is race-free; without
  //    it we'd still be safe because UPDATE ... RETURNING is atomic,
  //    but the unique constraint on (matchId, seq) would catch any
  //    bug.
  const [row] = await tx
    .update(matches)
    .set({ lastEventSeq: sql`${matches.lastEventSeq} + 1` })
    .where(eq(matches.id, matchId))
    .returning({ seq: matches.lastEventSeq });
  if (!row) {
    throw new Error(
      `writeMatchEvent: match ${matchId} not found while bumping last_event_seq`,
    );
  }
  const seq = row.seq;

  // 2. Insert the event with the assigned seq.
  await tx.insert(matchEvents).values({
    matchId,
    seq,
    kind,
    payload,
  });

  return seq;
}
