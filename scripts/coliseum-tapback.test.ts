/**
 * coliseum-tapback — spectator reactions semantics.
 *
 * P1 bucket. Validates POST /api/match/[id]/react:
 *
 *   1. anon-token + emoji → reaction persisted, broadcast emitted
 *   2. same anon-token + different emoji → previous emoji removed
 *      (tapback "latest wins" per source per target)
 *   3. same anon-token + same emoji again → toggles off
 *   4. different anon tokens don't dedupe against each other
 *
 * NOT TESTED (gap reported in summary, not asserted):
 *   - per-IP rate limit (10/60s) — endpoint has no rate limit today,
 *     per src/app/api/match/[id]/react/route.ts. Test plan scopes this
 *     for a future hardening sprint; for now we flag the absence.
 *
 * Run:
 *   pnpm coliseum:tapback
 *   MCP_ORIGIN=https://www.agentcoliseum.xyz pnpm coliseum:tapback
 */
import "dotenv/config";
import { eq, desc, and } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getAddress } from "viem";
import { db } from "../src/lib/db/client.js";
import {
  agents,
  matches,
  matchMoves,
  owners,
  tierCache,
  type MoveReaction,
} from "../src/lib/db/schema.js";

const ORIGIN = process.env.MCP_ORIGIN ?? "http://localhost:3000";

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

async function refreshTier(ownerId: string): Promise<void> {
  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId) });
  if (!owner) return;
  const checksummed = getAddress(owner.walletAddress as `0x${string}`);
  await db
    .insert(tierCache)
    .values({
      walletAddress: checksummed,
      balanceWei: (20_000_000n * 10n ** 18n).toString(),
      tier: "play", cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tierCache.walletAddress,
      set: { balanceWei: (20_000_000n * 10n ** 18n).toString(), tier: "play", cachedAt: new Date() },
    });
}

async function react(matchId: string, moveNumber: number, emoji: string, anonToken: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${ORIGIN}/api/match/${matchId}/react`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: { kind: "move", moveNumber },
      emoji,
      anonymousToken: anonToken,
    }),
  });
  let body: Record<string, unknown> = {};
  try { body = (await r.json()) as Record<string, unknown>; } catch { /* empty body */ }
  return { status: r.status, body };
}

/** Read the live reactions array off a move row. */
async function readReactions(moveId: string): Promise<MoveReaction[]> {
  const row = await db.query.matchMoves.findFirst({
    where: eq(matchMoves.id, moveId),
    columns: { reactions: true },
  });
  return (row?.reactions ?? []) as MoveReaction[];
}

async function main() {
  console.log(`→ ORIGIN ${ORIGIN}`);

  const alpha = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-alpha") });
  if (!alpha) {
    console.error("alpha not seeded — run `pnpm mcp:duel`");
    process.exit(1);
  }
  await refreshTier(alpha.ownerId!);

  // Set up a match with at least one move so we have a target to react to.
  console.log("\n── setup: create system match + submit a move ──");
  const proposeResp = await mcpCall(alpha.apiKey, "coliseum_challenge_propose", {
    gameType: "tic-tac-toe",
    mode: "system",
    systemBotDifficulty: "easy",
    perMoveSeconds: 60,
  });
  const proposeBody = parseBody<{ match?: { id: string }; error?: string }>(proposeResp);
  const matchId = proposeBody?.match?.id;
  if (!matchId) {
    console.error(`propose failed: ${JSON.stringify(proposeBody).slice(0, 200)}`);
    process.exit(1);
  }
  const moveResp = await mcpCall(alpha.apiKey, "coliseum_match_move", {
    matchId,
    payload: { index: 4 },
    reasoning: "Tapback test: claim center as the first move so spectators have a target to react to.",
  });
  const moveBody = parseBody<{ moveCount?: number; error?: string }>(moveResp);
  if (moveBody?.error || (moveBody?.moveCount ?? 0) < 1) {
    console.error(`move failed: ${JSON.stringify(moveBody).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`  (match ${matchId.slice(0, 8)} created · move 1 submitted at index 4)`);

  // Find the move's DB id so we can directly verify the reaction row.
  // Move number 0 is what spectators target with target.moveNumber.
  const moveRow = await db.query.matchMoves.findFirst({
    where: eq(matchMoves.matchId, matchId),
    orderBy: [desc(matchMoves.moveNumber)],
  });
  if (!moveRow) {
    console.error(`no match_moves row written — can't run reaction tests`);
    process.exit(1);
  }

  console.log(`\n── 1 · anon-token + emoji posts a reaction ──`);
  const tokenA = `test-anon-${randomBytes(8).toString("hex")}`;
  {
    const r = await react(matchId, moveRow.moveNumber, "🔥", tokenA);
    if (r.status !== 200) {
      fail(`react POST returns 200`, `got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    } else {
      const reactions = await readReactions(moveRow.id);
      const ours = reactions.find((row) => row.emoji === "🔥");
      if (ours) {
        pass(`reaction 🔥 from anon token ${tokenA.slice(0, 16)}… persisted in DB (${reactions.length} total)`);
      } else {
        fail(`reaction persistence`, `no 🔥 entry found in move.reactions; entries: ${reactions.length} (${reactions.map((r) => r.emoji).join(", ")})`);
      }
    }
  }

  console.log(`\n── 2 · same token + different emoji → previous removed (tapback latest-wins) ──`);
  {
    const r = await react(matchId, moveRow.moveNumber, "🤔", tokenA);
    if (r.status !== 200) {
      fail(`tapback switch POST returns 200`, `got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    } else {
      const reactions = await readReactions(moveRow.id);
      // Identify tokenA's entries by the hashed anon token (server hashes
      // the token before storing). We can find them by the at-timestamp
      // ordering: tokenA's entries are the ones we just posted (most
      // recent activity within this run).
      //
      // Simpler: assert the aggregated state — there should be 🤔 from
      // SOME source matching tokenA (we can't see the hash, but we can
      // see total count of 🔥 vs 🤔).
      const fires = reactions.filter((row) => row.emoji === "🔥");
      const thinks = reactions.filter((row) => row.emoji === "🤔");
      // Before this switch we had 1×🔥. After switching from A: 0×🔥 (A
      // removed) and 1×🤔 (A's new). Total reactions should be 1.
      if (reactions.length === 1 && thinks.length === 1 && fires.length === 0) {
        pass(`tapback switch: 🔥 removed, 🤔 added (latest-wins per source)`);
      } else {
        fail(`tapback latest-wins`, `expected 0×🔥 + 1×🤔 after switch; got ${fires.length}×🔥 + ${thinks.length}×🤔, total ${reactions.length}`);
      }
    }
  }

  console.log(`\n── 3 · same token + same emoji again → toggles off ──`);
  {
    const r = await react(matchId, moveRow.moveNumber, "🤔", tokenA);
    if (r.status !== 200) {
      fail(`tapback toggle POST returns 200`, `got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    } else {
      const reactions = await readReactions(moveRow.id);
      const thinks = reactions.filter((row) => row.emoji === "🤔");
      // tokenA toggling 🤔 should remove tokenA's 🤔 entry. No other source
      // has reacted yet, so total should drop to 0.
      if (reactions.length === 0) {
        pass(`tapback toggle: 🤔 removed when sent again from same source`);
      } else {
        fail(`tapback toggle`, `expected 0 reactions after toggle; got ${reactions.length} (${reactions.map((r) => r.emoji).join(", ")})`);
      }
    }
  }

  console.log(`\n── 4 · different anon tokens are independent ──`);
  const tokenB = `test-anon-${randomBytes(8).toString("hex")}`;
  {
    // From token A: re-add 🔥
    await react(matchId, moveRow.moveNumber, "🔥", tokenA);
    // From token B: also add 🔥. Both should persist as independent entries.
    const r2 = await react(matchId, moveRow.moveNumber, "🔥", tokenB);
    if (r2.status !== 200) {
      fail(`second anon-token POST returns 200`, `got ${r2.status}`);
    } else {
      const reactions = await readReactions(moveRow.id);
      const fires = reactions.filter((row) => row.emoji === "🔥");
      // tokenA + tokenB both fired 🔥 → 2 entries.
      if (fires.length === 2) {
        pass(`two different anon tokens both posted 🔥 (${fires.length} entries, no dedupe across tokens)`);
      } else {
        fail(`anon-token isolation`, `expected exactly 2 🔥 entries (one per token), got ${fires.length}`);
      }
    }
  }

  console.log(`\n── 5 · per-IP rate-limit — endpoint does NOT enforce one yet (gap finding) ──`);
  {
    // Burst 12 reactions from the same IP. We expect ALL 12 to return 200
    // today because there's no rate limiter on this endpoint. If any
    // return 429, the limiter has been added — flip this to a real check.
    const burst = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        react(matchId, moveRow.moveNumber, ["🔥","🤔","🎉","💀","✨","🚀","👀","🧠","⚡","🎯","🏆","💎"][i] ?? "🔥", tokenB + `-${i}`),
      ),
    );
    const status429 = burst.filter((r) => r.status === 429).length;
    if (status429 === 0) {
      console.log(`  ⚠ no rate limit enforced — 12 reactions in ~50ms all returned ${burst[0]?.status}. Test plan scoped 10/60s; expected to remain absent until a hardening sprint adds it. NOT asserting.`);
    } else {
      console.log(`  ! ${status429} of 12 returned 429 — looks like a rate limiter has been added. Update this test to assert against it.`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n══════════ summary ══════════`);
  console.log(`tapback semantics   ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`\n${failed} check(s) failed ↑`);
    process.exit(1);
  }
  console.log(`\n✓ tapback latest-wins + same-emoji toggle + anon-token isolation all hold`);
  console.log(`(gap: per-IP rate limiter not yet implemented — track for future sprint)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
