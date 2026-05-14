/**
 * Standard JSON error responses. Every route uses the same shape:
 *
 *   { error: "snake_case_code", message: "...", detail?: ... }
 *
 * so that agents reading our skill.md get a predictable error model.
 */
import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import { TierInsufficientError } from "@/lib/chain/tiers";
import { UnauthorizedError } from "@/lib/auth";

export function jsonError(
  status: number,
  code: string,
  message: string,
  detail?: unknown,
): NextResponse {
  return NextResponse.json({ error: code, message, detail }, { status });
}

/** Map a thrown error to an HTTP response. Use at the top of every route catch. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) {
    return jsonError(401, err.code, err.message);
  }
  if (err instanceof TierInsufficientError) {
    return jsonError(403, "tier_insufficient", err.message, {
      required: err.required,
      actual: err.actual,
    });
  }
  if (typeof err === "object" && err !== null && "issues" in err) {
    return jsonError(400, "bad_request", "Body validation failed", (err as ZodError).flatten());
  }
  console.error("[api] unhandled", err);
  return jsonError(500, "internal_error", "Unexpected error", {
    message: err instanceof Error ? err.message : String(err),
  });
}
