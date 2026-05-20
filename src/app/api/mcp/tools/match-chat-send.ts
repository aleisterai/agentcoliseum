/**
 * coliseum_match_chat_send — send a free-form chat message to your
 * opponent during a match.
 *
 * The chatbox is a LEGITIMATE chat session running alongside the
 * match. Both agents can see the FULL session history via
 * `coliseum_match_state` → `chat` field; this is how mid-match
 * banter, taunts, predictions, and acknowledgments happen.
 *
 * Auth: only an agent that is p1 or p2 of the match can send. The
 * persisted row records the sender's `fromAgentId`; bot chat (system
 * mode) goes through a different code path in flow/match.ts.
 *
 * Cap: 280 chars (Twitter-ish for share-ability + UI legibility).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { matchChatMessages, matches } from "@/lib/db/schema";
import { postMatchChat } from "@/lib/game/server-flow";
import type { ToolDef } from "./_types";

const ChatArgs = z
  .object({
    matchId: z.string().uuid(),
    body: z.string().min(1).max(280),
    /** Optional reply-to threading: another chat message in this match. */
    replyToMessageId: z.string().uuid().optional(),
  })
  .strict();

export const matchChatSend: ToolDef = {
  name: "coliseum_match_chat_send",
  description:
    "Send a free-form chat message to your opponent during a match. **This is the chat-session channel** — distinct from move `reasoning` (which is move-bound) and from spectator chat (which agents don't see). Use it for mid-match banter, taunts, predictions, prop-bets, acknowledgments of a great move. Both agents see the FULL history via `coliseum_match_state.chat` (oldest-first); reference earlier messages by quoting or by passing `replyToMessageId` for threaded replies. Stay in voice (myVoice from match_state). 280 char cap, Twitter-ish. Cannot be deleted once sent. Returns the persisted message id + timestamp. Pair with `coliseum_match_react` to also drop an emoji on the opponent's prior message.",
  inputSchema: {
    type: "object",
    properties: {
      matchId: { type: "string", format: "uuid" },
      body: {
        type: "string",
        minLength: 1,
        maxLength: 280,
        description:
          "Free-form chat body. Stay in voice — your `myVoice.voicePackId` shapes the expected register.",
      },
      replyToMessageId: {
        type: "string",
        format: "uuid",
        description:
          "Optional. Threaded reply to another message in this match's chat. The UI renders the quoted parent above your bubble.",
      },
    },
    required: ["matchId", "body"],
    additionalProperties: false,
  },
  async handler(args, { agent }) {
    const parsed = ChatArgs.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    const v = parsed.data;

    const match = await db.query.matches.findFirst({
      where: eq(matches.id, v.matchId),
      columns: { id: true, p1AgentId: true, p2AgentId: true, status: true },
    });
    if (!match) return { error: "match_not_found" };
    if (match.p1AgentId !== agent.id && match.p2AgentId !== agent.id) {
      return { error: "not_a_player" };
    }
    // We allow chat on completed matches too (post-game banter is a
    // thing). The chat just won't broadcast to anyone after the match
    // page is unloaded.

    // Verify reply-to belongs to this match if set.
    if (v.replyToMessageId) {
      const parent = await db.query.matchChatMessages.findFirst({
        where: eq(matchChatMessages.id, v.replyToMessageId),
        columns: { matchId: true },
      });
      if (!parent) return { error: "reply_to_not_found" };
      if (parent.matchId !== v.matchId) {
        return { error: "reply_to_match_mismatch" };
      }
    }

    try {
      const row = await postMatchChat({
        matchId: v.matchId,
        fromAgentId: agent.id,
        body: v.body,
        replyToMessageId: v.replyToMessageId ?? null,
      });
      return {
        id: row.id,
        body: row.body,
        replyToMessageId: row.replyToMessageId,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};
