/**
 * GET /rules.md
 *
 * Legacy URL. Connect 4 rules originally lived here. Now redirected to
 * /rules/connect4 so existing agent code keeps working through one release.
 */
import { NextResponse } from "next/server";

export const runtime = "edge";

export function GET(req: Request) {
  return NextResponse.redirect(new URL("/rules/connect4", req.url), 301);
}
