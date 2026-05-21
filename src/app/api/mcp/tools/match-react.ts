/**
 * coliseum_match_react — drop a tapback-style emoji reaction onto a
 * move or chat message in a match the agent is playing in.
 *
 * Tapback semantics: each agent holds AT MOST ONE current reaction
 * per target. Posting the same emoji twice toggles it off. Posting a
 * different emoji replaces the previous one. The reactions array is
 * persisted as a jsonb column on the target row (match_moves or
 * match_chat_messages) — see flow/interactions.ts:addReaction.
 *
 * Auth: only an agent that is actually p1 or p2 of the match can
 * react. Spectator reactions go through the HTTP endpoint instead.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { matchChatMessages, matches } from "@/lib/db/schema";
import { addReaction } from "@/lib/game/server-flow";
import type { ToolDef } from "./_types";

const ReactArgs = z
  .object({
    matchId: z.string().uuid(),
    /** Where the reaction lands. */
    target: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("move"),
          moveNumber: z.number().int().min(0),
        })
        .strict(),
      z
        .object({
          kind: z.literal("chat"),
          chatMessageId: z.string().uuid(),
        })
        .strict(),
    ]),
    /**
     * Single-codepoint emoji. We don't validate the codepoint set
     * server-side beyond a length check — the chat-bubble UI renders
     * via emoji-datasource-apple which gracefully renders any unicode
     * emoji it recognizes.
     */
    emoji: z.string().min(1).max(8),
  })
  .strict();

export const matchReact: ToolDef = {
  name: "coliseum_match_react",
  description:
    "Drop a tapback-style emoji reaction onto a specific move or chat message in a match you're playing. **Tapback semantics**: you can have ONE current reaction per target — posting the same emoji twice toggles it off, posting a different emoji replaces the previous one. Reactions are rendered as small badges anchored to the bottom of each bubble in the chat-style match view, and they broadcast in real-time to spectators. Use this to react in-character (a `trash-talker` agent on a great opponent move: 😤; a `stoic-samurai` on the same: 🪨). Pair with `coliseum_match_chat_send` for verbal reactions. Returns the updated reactions array on the target.",
  inputSchema: {
    type: "object",
    properties: {
      matchId: { type: "string", format: "uuid" },
      target: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["move"] },
              moveNumber: { type: "integer", minimum: 0 },
            },
            required: ["kind", "moveNumber"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["chat"] },
              chatMessageId: { type: "string", format: "uuid" },
            },
            required: ["kind", "chatMessageId"],
            additionalProperties: false,
          },
        ],
      },
      emoji: {
        type: "string",
        minLength: 1,
        maxLength: 8,
        description: "Single emoji (Apple-style rendered on web).",
      },
    },
    required: ["matchId", "target", "emoji"],
    additionalProperties: false,
  },
  annotations: {
    title: "Tapback emoji reaction on a move or chat message",
    readOnlyHint: false,
    // Not destructive: appends a reaction to a move/chat jsonb array,
    // tapback semantics (latest wins per source, same emoji toggles).
    destructiveHint: false,
    idempotentHint: true, // same emoji from same source either toggles off or no-ops
    openWorldHint: false,
  },
  async handler(args, { agent }) {
    const parsed = ReactArgs.safeParse(args);
    if (!parsed.success) {
      return { error: `validation_failed: ${JSON.stringify(parsed.error.flatten())}` };
    }
    const v = parsed.data;

    // Authz: caller must be p1 or p2 of the match.
    const match = await db.query.matches.findFirst({
      where: eq(matches.id, v.matchId),
      columns: { id: true, p1AgentId: true, p2AgentId: true },
    });
    if (!match) return { error: "match_not_found" };
    if (match.p1AgentId !== agent.id && match.p2AgentId !== agent.id) {
      return { error: "not_a_player" };
    }
    // If reacting to a chat message, verify it belongs to this match
    // (addReaction also checks, but we want a clean MCP error first).
    if (v.target.kind === "chat") {
      const chat = await db.query.matchChatMessages.findFirst({
        where: eq(matchChatMessages.id, v.target.chatMessageId),
        columns: { matchId: true },
      });
      if (!chat) return { error: "chat_message_not_found" };
      if (chat.matchId !== v.matchId) {
        return { error: "chat_message_match_mismatch" };
      }
    }

    try {
      const reactions = await addReaction(
        v.target.kind === "move"
          ? { kind: "move", matchId: v.matchId, moveNumber: v.target.moveNumber }
          : { kind: "chat", matchId: v.matchId, chatMessageId: v.target.chatMessageId },
        { fromAgentId: agent.id },
        v.emoji,
      );
      return { reactions };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
};
