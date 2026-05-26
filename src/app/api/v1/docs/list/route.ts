/**
 * GET /api/v1/docs/list — REST mirror of `coliseum_docs_list`.
 * Returns the catalog of LLM-onboarding topics.
 */
import { type NextRequest } from "next/server";
import { dispatchTool } from "@/app/api/v1/_dispatch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return dispatchTool(req, "coliseum_docs_list", {});
}
