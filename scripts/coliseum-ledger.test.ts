/**
 * coliseum-ledger — money-flow invariant + forbidden-flow battery.
 *
 * P0 bucket 2 of 3. Two independent halves:
 *
 *   A. LEDGER TIE-OUT (read-only DB scan).
 *      For every completed match in the last N days the books MUST
 *      reconcile. The invariants this proves:
 *
 *        invariant 1: pot = stake × 2  (escrow conservation)
 *        invariant 2: platform_fee = round(pot × 0.05) for non-draw wins
 *        invariant 3: platform_fee = 0 for draws  (Sprint 29)
 *        invariant 4: payout_tx_hash set ⇔ payout_at set
 *        invariant 5: every fee row in matches has a treasury_flows row
 *        invariant 6: sum(matches.platform_fee_usdc) ==
 *                     sum(treasury_flows.fee_usdc)  for the same window
 *
 *      A bank-tie-out style scan. Catches:
 *        - stake/pot drift from a bad cron deploy
 *        - missing treasury_flows rows
 *        - draws that wrongly took a fee
 *        - settled matches with no on-chain tx hash
 *
 *   B. FORBIDDEN-FLOW ASSERTIONS (MCP tool calls, no money moves).
 *      Every shape of "you can't do that" the agent surface must reject:
 *        - paid + system-bot is silently mode-exclusive (verified)
 *        - self-accept a challenge → error
 *        - move without reasoning → error
 *        - move on a match where it isn't your turn → error
 *        - unknown game type at propose → error
 *
 * Run:
 *   pnpm coliseum:ledger
 *   MCP_ORIGIN=https://www.agentcoliseum.xyz pnpm coliseum:ledger
 *
 * Exit 0 if all invariants hold + every forbidden flow rejected; 1 on drift.
 */
import "dotenv/config";
import { eq, gte, and } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "../src/lib/db/client.js";
import { agents, matches, owners, tierCache, treasuryFlows } from "../src/lib/db/schema.js";

/**
 * The challenge_propose tier gate hits Base RPC and caches the result
 * for 60s in tier_cache. mcp-prod-e2e refreshes the cache so its
 * happy-path runs don't trip the gate on empty test wallets; we need
 * the same primer before the forbidden-flow section.
 */
async function refreshTier(ownerId: string): Promise<void> {
  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId) });
  if (!owner) return;
  const checksummed = getAddress(owner.walletAddress as `0x${string}`);
  await db
    .insert(tierCache)
    .values({
      walletAddress: checksummed,
      balanceWei: (20_000_000n * 10n ** 18n).toString(),
      tier: "play",
      cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tierCache.walletAddress,
      set: {
        balanceWei: (20_000_000n * 10n ** 18n).toString(),
        tier: "play",
        cachedAt: new Date(),
      },
    });
}

const ORIGIN = process.env.MCP_ORIGIN ?? "http://localhost:3000";
const SCAN_DAYS = Number(process.env.LEDGER_SCAN_DAYS ?? "30");

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
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })
  ).json()) as JsonRpcResp;
}

/**
 * Pulls the tool's payload text and parses it. Tools return either
 * { result: { content: [{ text: '{...json...}' }] } } on success or
 * { error: {...} } on framework-level failure. Tool-level "no, you
 * can't" errors come through as a success envelope with the parsed
 * body containing { error: "..." }.
 */
function parseToolBody<T = Record<string, unknown>>(r: JsonRpcResp): T | null {
  const t = r.result?.content?.[0]?.text;
  if (!t) return null;
  try { return JSON.parse(t) as T; } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// A · Ledger tie-out
// ═══════════════════════════════════════════════════════════
async function ledgerInvariants() {
  console.log(`\n── A · ledger tie-out (last ${SCAN_DAYS}d, read-only) ──`);

  const since = new Date(Date.now() - SCAN_DAYS * 24 * 60 * 60 * 1000);

  // Pull every completed match in the window. We compute invariants per row,
  // then aggregate at the end for the treasury_flows cross-check.
  const completed = await db
    .select({
      id: matches.id,
      gameType: matches.gameType,
      mode: matches.mode,
      stakeUsdc: matches.stakeUsdc,
      potUsdc: matches.potUsdc,
      platformFeeUsdc: matches.platformFeeUsdc,
      payoutTxHash: matches.payoutTxHash,
      payoutAt: matches.payoutAt,
      winnerAgentId: matches.winnerAgentId,
      status: matches.status,
      completedAt: matches.completedAt,
    })
    .from(matches)
    .where(
      and(
        eq(matches.status, "completed"),
        gte(matches.completedAt, since),
      ),
    );

  console.log(`  scanning ${completed.length} completed match(es) since ${since.toISOString().slice(0, 10)}`);

  let inv1 = 0, inv2 = 0, inv3 = 0, inv4 = 0;
  const drift: string[] = [];
  let sumMatchFees = 0;

  for (const m of completed) {
    // Free matches have null stake / null pot — skip (nothing to reconcile).
    if (m.stakeUsdc == null || m.stakeUsdc === 0) continue;

    // invariant 1: pot = stake × 2 (both sides escrow the same)
    const expectedPot = m.stakeUsdc * 2;
    if (m.potUsdc !== expectedPot) {
      drift.push(`match ${m.id.slice(0, 8)}: pot ${m.potUsdc} ≠ stake×2 ${expectedPot}`);
    } else inv1++;

    const isDraw = m.winnerAgentId == null;

    if (isDraw) {
      // invariant 3: draws charge NO fee
      if (m.platformFeeUsdc !== 0 && m.platformFeeUsdc !== null) {
        drift.push(`match ${m.id.slice(0, 8)} (DRAW): platform_fee ${m.platformFeeUsdc} ≠ 0`);
      } else inv3++;
    } else {
      // invariant 2: non-draw fee = round(pot × 0.05)
      const expectedFee = Math.round((m.potUsdc ?? 0) * 0.05);
      const fee = m.platformFeeUsdc ?? 0;
      if (Math.abs(fee - expectedFee) > 1) {
        drift.push(`match ${m.id.slice(0, 8)}: platform_fee ${fee} ≠ 5%·pot ${expectedFee}`);
      } else inv2++;
      sumMatchFees += fee;
    }

    // invariant 4: payoutTxHash <=> payoutAt (both set or both null)
    const hasHash = !!m.payoutTxHash;
    const hasTime = !!m.payoutAt;
    if (hasHash !== hasTime) {
      drift.push(`match ${m.id.slice(0, 8)}: payoutTxHash=${hasHash} but payoutAt=${hasTime}`);
    } else inv4++;
  }

  if (drift.length === 0) {
    pass(`invariants 1-4 hold for all ${completed.length} matches  [stake×2, 5% fee, draw=0 fee, hash↔time]`);
  } else {
    fail(`invariants 1-4`, `${drift.length} drift row(s):\n      ${drift.slice(0, 10).join("\n      ")}${drift.length > 10 ? `\n      ... +${drift.length - 10} more` : ""}`);
  }

  // invariant 5 + 6: sum of platform_fee in matches == sum of fee in treasury_flows
  const tfRows = await db
    .select({ feeUsdc: treasuryFlows.feeUsdc, matchId: treasuryFlows.matchId })
    .from(treasuryFlows)
    .where(gte(treasuryFlows.createdAt, since));
  const sumTfFees = tfRows.reduce((s, r) => s + r.feeUsdc, 0);

  if (sumMatchFees === sumTfFees) {
    pass(`treasury tie-out: sum(matches.platform_fee)=${sumMatchFees}µUSDC == sum(treasury_flows.fee)=${sumTfFees}µUSDC`);
  } else {
    fail(`treasury tie-out`, `sum(matches)=${sumMatchFees} ≠ sum(treasury_flows)=${sumTfFees} — drift ${sumMatchFees - sumTfFees}µUSDC`);
  }

  // every fee match should have a treasury_flows row (invariant 5)
  const matchesWithFee = completed.filter((m) => (m.platformFeeUsdc ?? 0) > 0);
  const tfMatchIds = new Set(tfRows.map((r) => r.matchId).filter(Boolean) as string[]);
  const orphans = matchesWithFee.filter((m) => !tfMatchIds.has(m.id));
  if (orphans.length === 0) {
    pass(`every fee-paying match has a treasury_flows row`);
  } else {
    fail(`treasury_flows orphans`, `${orphans.length} match(es) with fee but no treasury_flows row: ${orphans.slice(0, 5).map((m) => m.id.slice(0, 8)).join(", ")}`);
  }
}

// ═══════════════════════════════════════════════════════════
// B · Forbidden flows (MCP-driven, no money moves)
// ═══════════════════════════════════════════════════════════
async function forbiddenFlows() {
  console.log("\n── B · forbidden flows ──");

  const alpha = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-alpha") });
  const beta = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-beta") });
  if (!alpha || !beta) {
    fail("forbidden-flow setup", "mcp-duel-alpha or mcp-duel-beta missing — run `pnpm mcp:duel` first");
    return;
  }

  // Prime tier_cache so the propose tier gate doesn't trip on empty
  // test wallets (the seeded mcp-duel agents hold 0 ALEISTER on-chain;
  // the cache row gives them the `play` tier the propose path requires).
  await refreshTier(alpha.ownerId);
  await refreshTier(beta.ownerId);
  console.log(`  (primed tier_cache for both test agents)`);

  // B1 · paid + system-bot — production-data invariant check.
  //      Mode is an enum (free|paid|system) but the propose path doesn't
  //      explicitly reject mode=system + stakeUsdc — it relies on the
  //      stake-pull branch only firing for mode=paid. We verify the
  //      product invariant directly: query EVERY system match ever
  //      created and assert none holds a non-null stakeUsdc. This catches
  //      the worst case (a system match accidentally escrowed money)
  //      without the Guardian budget cap masking the test.
  {
    const systemMatchesWithStake = await db
      .select({ id: matches.id, mode: matches.mode, stakeUsdc: matches.stakeUsdc })
      .from(matches)
      .where(and(eq(matches.mode, "system")));
    const leaked = systemMatchesWithStake.filter((m) => m.stakeUsdc != null && m.stakeUsdc > 0);
    if (leaked.length === 0) {
      pass(`all ${systemMatchesWithStake.length} system-mode matches have stakeUsdc=null (paid-vs-bot invariant holds)`);
    } else {
      fail(
        `paid + system-bot leak`,
        `${leaked.length} system-mode match(es) hold non-null stake — PRODUCT INVARIANT VIOLATED: ${leaked.slice(0, 5).map((m) => `${m.id.slice(0, 8)}=${m.stakeUsdc}`).join(", ")}`,
      );
    }
  }

  // B2 · self-accept own challenge.
  //      Post a free challenge as alpha; alpha tries to accept it.
  //      Response shape from propose is { kind, challenge: { id, ... } }.
  {
    const post = await mcpCall(alpha.apiKey, "coliseum_challenge_propose", {
      gameType: "tic-tac-toe", mode: "free",
    });
    const postBody = parseToolBody<{ kind?: string; challenge?: { id: string }; error?: string }>(post);
    const challengeId = postBody?.challenge?.id;
    if (postBody?.error || !challengeId) {
      fail(`self-accept setup`, `couldn't post free challenge: ${JSON.stringify(postBody).slice(0, 200)}`);
    } else {
      const accept = await mcpCall(alpha.apiKey, "coliseum_challenge_accept", {
        challengeId,
      });
      const acceptBody = parseToolBody<{ error?: string; kind?: string }>(accept);
      if (acceptBody?.error && /self|own|own_challenge|cannot/i.test(acceptBody.error)) {
        pass(`self-accept → rejected: ${acceptBody.error.slice(0, 80)}`);
      } else if (acceptBody?.kind === "match") {
        fail(`self-accept`, `accepted own challenge — alpha vs alpha match created`);
      } else {
        fail(`self-accept`, `unexpected: ${JSON.stringify(acceptBody).slice(0, 200)}`);
      }
      // The challenge stays open in the lobby; refund-expired cron picks
      // it up at the timeout boundary. Negligible noise — by design no
      // cancel tool exists on the MCP surface (per Sprint 40 lobby work).
    }
  }

  // B3 · unknown gameType at propose.
  {
    const r = await mcpCall(alpha.apiKey, "coliseum_challenge_propose", {
      gameType: "not-a-real-game-xyz", mode: "free",
    });
    const body = parseToolBody<{ error?: string }>(r);
    if (body?.error && /unknown_game_type|invalid|not.*found/i.test(body.error)) {
      pass(`propose unknown gameType → rejected: ${body.error.slice(0, 80)}`);
    } else {
      fail(`unknown gameType`, `unexpected: ${JSON.stringify(body).slice(0, 200)}`);
    }
  }

  // B4 · move without reasoning, on a match that exists.
  //      Find any active match alpha is in. If none, this case is skipped
  //      (the prod e2e covers happy-path move; this only tests the validation).
  {
    const list = await mcpCall(alpha.apiKey, "coliseum_match_list", {});
    const listBody = parseToolBody<{ activeMatches?: Array<{ matchId: string; isMyTurn: boolean }> }>(list);
    const myTurnMatch = listBody?.activeMatches?.find((m) => m.isMyTurn);
    if (!myTurnMatch) {
      console.log(`    (skipped move-without-reasoning — alpha has no on-turn active match)`);
    } else {
      const r = await mcpCall(alpha.apiKey, "coliseum_match_move", {
        matchId: myTurnMatch.matchId,
        move: { col: 0 }, // valid Connect 4 shape, but no reasoning field
        // reasoning: intentionally omitted
      });
      const body = parseToolBody<{ error?: string }>(r);
      if (body?.error && /missing_reasoning|reasoning.*required/i.test(body.error)) {
        pass(`move without reasoning → rejected: ${body.error.slice(0, 80)}`);
      } else if (r.error?.code && r.error.code !== 0) {
        // Some tools shape mandatory-field errors as JSON-RPC errors with -32602.
        pass(`move without reasoning → JSON-RPC ${r.error.code}: ${r.error.message}`);
      } else {
        fail(`move without reasoning`, `accepted? response: ${JSON.stringify(body ?? r).slice(0, 200)}`);
      }
    }
  }

  // B5 · move on a match where it isn't your turn.
  //      Find an active match beta is in (alpha's perspective: not alpha's turn).
  {
    const list = await mcpCall(alpha.apiKey, "coliseum_match_list", {});
    const listBody = parseToolBody<{ activeMatches?: Array<{ matchId: string; isMyTurn: boolean }> }>(list);
    const notMyTurnMatch = listBody?.activeMatches?.find((m) => !m.isMyTurn);
    if (!notMyTurnMatch) {
      console.log(`    (skipped not-your-turn — alpha has no off-turn active match)`);
    } else {
      const r = await mcpCall(alpha.apiKey, "coliseum_match_move", {
        matchId: notMyTurnMatch.matchId,
        move: { col: 0 },
        reasoning: "intentionally testing not-your-turn rejection",
      });
      const body = parseToolBody<{ error?: string }>(r);
      if (body?.error && /not.*your.*turn|wait/i.test(body.error)) {
        pass(`move when not on turn → rejected: ${body.error.slice(0, 80)}`);
      } else {
        fail(`move when not on turn`, `accepted? ${JSON.stringify(body ?? r).slice(0, 200)}`);
      }
    }
  }
}

async function main() {
  console.log(`→ ORIGIN ${ORIGIN}`);
  console.log(`→ SCAN_DAYS ${SCAN_DAYS}`);

  await ledgerInvariants();
  await forbiddenFlows();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n══════════ summary ══════════`);
  console.log(`ledger + forbidden   ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`\n${failed} CHECK(S) FAILED — money flow or invariant drift ↑`);
    process.exit(1);
  }
  console.log(`\n✓ ledger reconciles · every forbidden flow rejected`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
