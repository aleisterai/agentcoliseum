/**
 * coliseum-races — concurrency invariant battery.
 *
 * P1 bucket — every "what if two agents call this at the exact same
 * instant?" path. Each case fires N parallel requests and asserts
 * that the server's row-lock / turn-lock / refcount holds.
 *
 * Why dedicated: integration tests that walk one happy path at a
 * time don't surface races. A challenge_accept race that double-
 * stakes both wallets, or a match_move race that decrements the
 * clock twice, is a P0 bug that LOOKS like green CI under sequential
 * tests. The only way to catch it is to fire parallel requests.
 *
 * Cases:
 *
 *   1. Concurrent challenge_accept — 5 parallel accepts on one open
 *      challenge. Exactly 1 must succeed; the other 4 must get
 *      `already_accepted` (or a sibling error). Proves the
 *      challenges row's `accepted_at IS NULL` row-lock holds.
 *
 *   2. Concurrent match_move — 2 parallel moves from the same agent
 *      on the same turn. Exactly 1 must succeed (moveCount: 0 → 1);
 *      the second must see the turn has already advanced.
 *
 * Run:
 *   pnpm coliseum:races
 *   MCP_ORIGIN=https://www.agentcoliseum.xyz pnpm coliseum:races
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "../src/lib/db/client.js";
import { agents, owners, tierCache } from "../src/lib/db/schema.js";

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

// ════════════════════════════════════════════════════════════
// 1 · Concurrent challenge accept (5-way race)
// ════════════════════════════════════════════════════════════
async function concurrentAccept(alphaAck: string, betaAck: string) {
  console.log("\n── concurrent challenge_accept (5-way) ──");

  // alpha posts a free, unpinned, open challenge that beta can take
  const post = await mcpCall(alphaAck, "coliseum_challenge_propose", {
    gameType: "tic-tac-toe", mode: "free",
  });
  const postBody = parseBody<{ kind?: string; challenge?: { id: string }; error?: string }>(post);
  const challengeId = postBody?.challenge?.id;
  if (!challengeId || postBody?.error) {
    fail("accept-race setup", `couldn't post challenge: ${JSON.stringify(postBody).slice(0, 200)}`);
    return;
  }

  // 5 parallel accepts, all from beta's credential. Only one row-lock
  // wins; the other 4 must return `already_accepted` or sibling shape.
  const N = 5;
  const promises = Array.from({ length: N }, () =>
    mcpCall(betaAck, "coliseum_challenge_accept", { challengeId }),
  );
  const responses = await Promise.all(promises);
  const bodies = responses.map((r) => parseBody<{ matchId?: string; kind?: string; match?: { id: string }; status?: string; error?: string }>(r));

  // A success is any body with a non-empty matchId and no error field.
  // (challenge_accept returns the match row flat: matchId + status + gameType + …)
  // Losers come in TWO shapes: `challenge_already_accepted` (DB row-lock
  // winner stamped the row first) OR `not_open: challenge is escrowed`
  // (the challenge moved out of the `open` state between our read and our
  // attempt — same outcome from the agent's perspective).
  const successes = bodies.filter((b) => b && !b.error && (b.matchId || b.match?.id));
  const alreadies = bodies.filter((b) => b?.error && /already|accepted|locked|taken|race|conflict|not_open|escrow/i.test(b.error));
  const others = bodies.length - successes.length - alreadies.length;

  if (successes.length === 1 && alreadies.length === N - 1) {
    pass(`5 parallel accepts → exactly 1 match created, ${N - 1} got already-accepted (row-lock holds)`);
  } else if (successes.length > 1) {
    const ids = successes.map((b) => (b?.matchId ?? b?.match?.id ?? "?").slice(0, 8)).join(", ");
    fail("accept-race lock failure", `DOUBLE-ACCEPT — ${successes.length} matches created from one challenge: ${ids}`);
  } else if (successes.length === 0) {
    fail("accept-race no winner", `0 of ${N} accepts succeeded — all ${alreadies.length} got already-accepted + ${others} unknown shape; first response: ${JSON.stringify(bodies[0]).slice(0, 200)}`);
  } else {
    // Dump every loser body so we can see what shape the server returned —
    // the "already-accepted" regex might be missing a real error code.
    const losers = bodies.filter((b) => !(b && !b.error && (b.matchId || b.match?.id)));
    fail(
      "accept-race mixed",
      `unexpected mix: ${successes.length} succeeded, ${alreadies.length} already, ${others} other.\n        loser bodies: ${losers.map((b) => JSON.stringify(b).slice(0, 120)).join("\n        ")}`,
    );
  }
}

// ════════════════════════════════════════════════════════════
// 2 · Concurrent match_move (2-way race on same turn)
// ════════════════════════════════════════════════════════════
async function concurrentMove(alphaAck: string, betaAck: string) {
  console.log("\n── concurrent match_move (2-way same-turn) ──");

  // Create a fresh match: alpha proposes pinned to beta, beta accepts.
  // We then fire 2 parallel moves from whichever side is on move.
  const post = await mcpCall(alphaAck, "coliseum_challenge_propose", {
    gameType: "tic-tac-toe", mode: "free",
    opponentHandle: "mcp-duel-beta",
    perMoveSeconds: 60,
  });
  const postBody = parseBody<{ challenge?: { id: string }; error?: string }>(post);
  const challengeId = postBody?.challenge?.id;
  if (!challengeId) {
    fail("move-race setup", `propose failed: ${JSON.stringify(postBody).slice(0, 200)}`);
    return;
  }
  const accept = await mcpCall(betaAck, "coliseum_challenge_accept", { challengeId });
  const acceptBody = parseBody<{ matchId?: string; match?: { id: string }; currentTurnPlayerId?: string; error?: string }>(accept);
  const matchId = acceptBody?.matchId ?? acceptBody?.match?.id;
  if (!matchId || acceptBody?.error) {
    fail("move-race setup", `accept failed: ${JSON.stringify(acceptBody).slice(0, 200)}`);
    return;
  }

  // Read state to determine who's on move.
  const state = await mcpCall(alphaAck, "coliseum_match_state", { matchId });
  const stateBody = parseBody<{ isMyTurn?: boolean; currentTurnPlayerId?: string }>(state);
  const alphaOnMove = stateBody?.isMyTurn === true;
  const moverAck = alphaOnMove ? alphaAck : betaAck;
  console.log(`    (${alphaOnMove ? "alpha" : "beta"} is on first move)`);

  // 2 parallel moves with the SAME legal payload. tic-tac-toe expects
  // { index: 0..8 } per the adapter — place at center (index 4).
  // Server's turn-advance is one transaction; only one of these can win.
  const movePayload = { index: 4 };
  const promises = [
    mcpCall(moverAck, "coliseum_match_move", {
      matchId, payload: movePayload,
      reasoning: "Race test request A: claim center to test concurrent-move turn-lock.",
    }),
    mcpCall(moverAck, "coliseum_match_move", {
      matchId, payload: movePayload,
      reasoning: "Race test request B: identical move shape — server must reject one.",
    }),
  ];
  const responses = await Promise.all(promises);
  // The move tool returns the match row flat after a successful apply:
  //   { matchId, status, moveCount, isMyTurn, currentTurnAgentId, ... }
  // A losing concurrent caller gets { error: "not_your_turn: ..." } or a
  // sibling. Detection: moveCount > 0 means OUR call advanced state.
  const bodies = responses.map((r) =>
    parseBody<{ matchId?: string; moveCount?: number; isMyTurn?: boolean; status?: string; ok?: boolean; error?: string }>(r),
  );

  const successes = bodies.filter((b) => b && !b.error && (b.moveCount ?? 0) > 0);
  const rejects = bodies.filter((b) => b?.error && /turn|already|locked|race|illegal|moved|advanced/i.test(b.error));

  if (successes.length === 1 && rejects.length === 1) {
    pass(`2 parallel moves → exactly 1 accepted, 1 rejected (turn-lock holds)`);
  } else if (successes.length === 2) {
    fail("move-race turn-lock failure", `BOTH moves accepted — clock decremented twice, state corrupted: ${JSON.stringify(bodies).slice(0, 300)}`);
  } else if (successes.length === 0) {
    // It's possible both moves landed AFTER turn advance (e.g., adapter requires `row,col` not `cell`).
    // Check whether both got a SAME error code — that suggests a payload schema mismatch, not a race issue.
    const firstErr = bodies[0]?.error;
    if (firstErr && bodies.every((b) => b?.error === firstErr)) {
      fail("move-race no winner (payload schema)", `both moves rejected identically: '${firstErr.slice(0, 80)}' — likely tic-tac-toe expects a different move shape, not a race failure. Adjust the test's move payload.`);
    } else {
      fail("move-race no winner", `0 of 2 accepted; sample bodies: ${JSON.stringify(bodies).slice(0, 400)}`);
    }
  } else {
    // Dump BOTH bodies in full so we can see what the loser returned
    // — the rejects regex might be missing a real error code, or the
    // loser could have come back with a state-read shape that we're
    // not classifying as a reject.
    fail(
      "move-race mixed",
      `unexpected: ${successes.length} succeeded, ${rejects.length} rejected.\n        bodies:\n        [0] ${JSON.stringify(bodies[0]).slice(0, 300)}\n        [1] ${JSON.stringify(bodies[1]).slice(0, 300)}`,
    );
  }
}

async function main() {
  console.log(`→ ORIGIN ${ORIGIN}`);

  const alpha = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-alpha") });
  const beta = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-beta") });
  if (!alpha || !beta) {
    console.error("alpha / beta not seeded — run `pnpm mcp:duel` first");
    process.exit(1);
  }
  await refreshTier(alpha.ownerId);
  await refreshTier(beta.ownerId);

  await concurrentAccept(alpha.apiKey, beta.apiKey);
  await concurrentMove(alpha.apiKey, beta.apiKey);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n══════════ summary ══════════`);
  console.log(`race tests   ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`\n${failed} race(s) failed — a row-lock or turn-lock is letting parallel requests through ↑`);
    process.exit(1);
  }
  console.log(`\n✓ all race invariants hold`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
