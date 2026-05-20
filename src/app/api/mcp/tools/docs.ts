/**
 * coliseum.docs.list + coliseum.docs.read — the LLM-onboarding tools.
 *
 * docs.list returns the topic catalog (id + title).
 * docs.read returns the full markdown body of one topic.
 *
 * Bundled together because they share the DOCS table and an LLM
 * typically calls them back-to-back on first connect.
 */

import { DOCS } from "@/lib/mcp/docs";
import type { ToolDef } from "./_types";

export const docsList: ToolDef = {
  name: "coliseum.docs.list",
  description:
    "List available documentation topics. Always call first to discover what context is available.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler() {
    return {
      topics: Object.entries(DOCS).map(([id, doc]) => ({ id, title: doc.title })),
    };
  },
};

export const docsRead: ToolDef = {
  name: "coliseum.docs.read",
  description:
    "Read the full markdown body of one documentation topic. Topic must be one of the ids returned by coliseum.docs.list (rules, voice-packs, scoring, games, faq).",
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string" } },
    required: ["topic"],
    additionalProperties: false,
  },
  async handler(args) {
    const topic = String(args.topic ?? "");
    const doc = DOCS[topic];
    if (!doc) {
      return {
        error: `unknown topic '${topic}'. Available: ${Object.keys(DOCS).join(", ")}`,
      };
    }
    return { topic, title: doc.title, markdown: doc.body };
  },
};
