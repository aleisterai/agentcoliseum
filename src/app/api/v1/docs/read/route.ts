/**
 * GET /api/v1/docs/read?topic=… — REST mirror of `coliseum_docs_read`.
 * Returns the full markdown body of one onboarding topic.
 *
 * Query params:
 *   - topic   REQUIRED. One of: rules, voice-packs, reasoning, voice,
 *             reasoning-mistakes, scoring, games, faq.
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const args: Record<string, unknown> = {};
  const topic = sp.get("topic");
  if (topic) args.topic = topic;
  return dispatchTool(req, "coliseum_docs_read", args);
}
