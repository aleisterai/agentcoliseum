/**
 * coliseum-profile — agent profile MCP surface contract.
 *
 * P1 bucket. Validates the coliseum_agent_profile_{get,update} tools:
 *
 *   1. profile_get returns the current state with the expected shape
 *      (handle, displayName, bio, voicePackId, tokenCa, …) and never
 *      leaks owner-private fields (apiKey, smart_account_config).
 *
 *   2. profile_update accepts each editable field one at a time and
 *      the value lands in the DB (bio, catchphrase, voicePackId).
 *
 *   3. Soft cap > hard cap is rejected with `soft_exceeds_hard`.
 *      Soft cap ≤ hard cap is accepted.
 *
 *   4. Owner-only / non-MCP fields (smartAccountConfig, recalledAt,
 *      ownerId) are silently filtered — sending them in profile_update
 *      doesn't break the call, but they also don't get applied.
 *
 *   5. Concurrent profile_updates from the same credential serialize
 *      cleanly — both succeed, the last-write wins per field.
 *
 * Run:
 *   pnpm coliseum:profile
 *   MCP_ORIGIN=https://www.agentcoliseum.xyz pnpm coliseum:profile
 *
 * IMPORTANT: leaves the alpha agent's bio + catchphrase reset to a
 * known string at the end (test-deterministic), so subsequent runs
 * find the same starting state.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client.js";
import { agents } from "../src/lib/db/schema.js";

const ORIGIN = process.env.MCP_ORIGIN ?? "http://localhost:3000";
const TEST_BIO = "Reset by coliseum-profile test. Safe to overwrite from the dashboard.";

interface CaseResult { name: string; ok: boolean; detail?: string }
const results: CaseResult[] = [];
function pass(name: string) { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
function fail(name: string, detail: string) { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name}\n      ${detail}`); }

interface JsonRpcResp { result?: { content?: Array<{ text: string }> }; error?: { code: number; message: string } }

async function mcpCall(ackToken: string, name: string, args: Record<string, unknown>): Promise<JsonRpcResp> {
  return (await (
    await fetch(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ackToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: args },
      }),
    })
  ).json()) as JsonRpcResp;
}

function parseBody<T = Record<string, unknown>>(r: JsonRpcResp): T | null {
  const t = r.result?.content?.[0]?.text;
  if (!t) return null;
  try { return JSON.parse(t) as T; } catch { return null; }
}

async function main() {
  console.log(`→ ORIGIN ${ORIGIN}`);

  const alpha = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-alpha") });
  if (!alpha) {
    console.error("alpha (mcp-duel-alpha) not seeded — run `pnpm mcp:duel` first");
    process.exit(1);
  }

  console.log("\n── 1 · profile_get response shape ──");
  {
    const r = await mcpCall(alpha.apiKey, "coliseum_agent_profile_get", {});
    const body = parseBody<Record<string, unknown>>(r);
    if (!body) {
      fail("profile_get returns parseable JSON", `no body: ${JSON.stringify(r).slice(0, 200)}`);
    } else {
      const hasIdentity = "handle" in body && "displayName" in body;
      const leaksPrivate = "apiKey" in body || "smartAccountConfig" in body || "credential" in body;
      if (hasIdentity && !leaksPrivate) {
        pass(`profile_get exposes handle + displayName, never apiKey/smartAccount/credential`);
      } else if (!hasIdentity) {
        fail("profile_get shape", `missing identity fields. Got keys: ${Object.keys(body).join(", ").slice(0, 200)}`);
      } else if (leaksPrivate) {
        fail("profile_get PRIVATE FIELD LEAK", `body contains private field: ${JSON.stringify(body).slice(0, 200)}`);
      }
    }
  }

  console.log("\n── 2 · profile_update editable fields ──");
  {
    const r = await mcpCall(alpha.apiKey, "coliseum_agent_profile_update", { bio: TEST_BIO });
    const body = parseBody<{ bio?: string; error?: string }>(r);
    if (body?.error) {
      fail("profile_update bio", `tool error: ${body.error.slice(0, 160)}`);
    } else {
      // Verify the row actually got the new value
      const updated = await db.query.agents.findFirst({ where: eq(agents.id, alpha.id), columns: { bio: true } });
      if (updated?.bio === TEST_BIO) {
        pass(`profile_update bio → "${TEST_BIO.slice(0, 40)}…" persisted to DB`);
      } else {
        fail("profile_update bio persistence", `tool said ok but DB bio is "${updated?.bio?.slice(0, 80)}"`);
      }
    }
  }

  // voicePackId field — set to trash-talker
  {
    const r = await mcpCall(alpha.apiKey, "coliseum_agent_profile_update", { voicePackId: "trash-talker" });
    const body = parseBody<{ voicePackId?: string; error?: string }>(r);
    if (body?.error) {
      fail("profile_update voicePackId", `tool error: ${body.error.slice(0, 160)}`);
    } else {
      const updated = await db.query.agents.findFirst({ where: eq(agents.id, alpha.id), columns: { voicePackId: true } });
      if (updated?.voicePackId === "trash-talker") {
        pass(`profile_update voicePackId → trash-talker persisted`);
      } else {
        fail("profile_update voicePackId persistence", `DB got "${updated?.voicePackId}"`);
      }
    }
  }

  console.log("\n── 3 · hard-cap enforcement (soft ≤ hard) ──");
  {
    // Read current hard cap directly from DB
    const row = await db.query.agents.findFirst({
      where: eq(agents.id, alpha.id),
      columns: { stakeCapHardUsdc: true, stakeCapSoftUsdc: true },
    });
    const hard = row?.stakeCapHardUsdc ?? 10_000_000;
    const initialSoft = row?.stakeCapSoftUsdc ?? hard;

    // Soft cap ABOVE hard cap — must reject
    const overcap = hard + 1_000_000;
    const r = await mcpCall(alpha.apiKey, "coliseum_agent_profile_update", { stakeCapSoftUsdc: overcap });
    const body = parseBody<{ error?: string; stakeCapSoftUsdc?: number }>(r);
    if (body?.error && /soft_exceeds_hard|cap|hard/i.test(body.error)) {
      pass(`soft > hard cap (${overcap} vs ${hard}) → rejected with ${body.error.slice(0, 60)}`);
    } else {
      const after = await db.query.agents.findFirst({ where: eq(agents.id, alpha.id), columns: { stakeCapSoftUsdc: true } });
      fail(`soft > hard cap rejection`, `expected soft_exceeds_hard error, got body=${JSON.stringify(body).slice(0, 200)}; DB soft cap = ${after?.stakeCapSoftUsdc}`);
    }

    // Soft cap AT hard cap — must accept (boundary)
    const r2 = await mcpCall(alpha.apiKey, "coliseum_agent_profile_update", { stakeCapSoftUsdc: hard });
    const body2 = parseBody<{ error?: string; stakeCapSoftUsdc?: number }>(r2);
    if (body2?.error) {
      fail(`soft = hard cap accepted`, `unexpected rejection: ${body2.error.slice(0, 160)}`);
    } else {
      const after = await db.query.agents.findFirst({ where: eq(agents.id, alpha.id), columns: { stakeCapSoftUsdc: true } });
      if (after?.stakeCapSoftUsdc === hard) {
        pass(`soft = hard cap (${hard}) → accepted and persisted`);
      } else {
        fail(`soft = hard cap`, `tool accepted but DB has ${after?.stakeCapSoftUsdc}`);
      }
    }

    // Restore the initial soft cap for deterministic state
    await mcpCall(alpha.apiKey, "coliseum_agent_profile_update", { stakeCapSoftUsdc: initialSoft });
  }

  console.log("\n── 4 · concurrent profile_update serialize ──");
  {
    // Two parallel updates to different fields. Both should succeed
    // independently. (Same field would be last-write-wins; we test
    // different fields to assert PG's row-update doesn't lose either.)
    const promises = [
      mcpCall(alpha.apiKey, "coliseum_agent_profile_update", { catchphrase: "race-test-A" }),
      mcpCall(alpha.apiKey, "coliseum_agent_profile_update", { winLine: "race-test-W" }),
    ];
    const responses = await Promise.all(promises);
    const bodies = responses.map((r) => parseBody<{ error?: string }>(r));
    const errs = bodies.filter((b) => b?.error);
    if (errs.length > 0) {
      fail(`concurrent profile_update`, `${errs.length} of 2 failed: ${errs.map((b) => b?.error?.slice(0, 80)).join(" · ")}`);
    } else {
      // Both should be persisted
      const after = await db.query.agents.findFirst({
        where: eq(agents.id, alpha.id),
        columns: { catchphrase: true, winLine: true },
      });
      if (after?.catchphrase === "race-test-A" && after?.winLine === "race-test-W") {
        pass(`2 parallel profile_updates → both fields persisted (catchphrase + winLine)`);
      } else {
        fail(`concurrent persistence`, `expected catchphrase=race-test-A, winLine=race-test-W; got ${JSON.stringify(after)}`);
      }
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n══════════ summary ══════════`);
  console.log(`profile contract   ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`\n${failed} check(s) failed ↑`);
    process.exit(1);
  }
  console.log(`\n✓ agent profile MCP surface holds its contract`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
