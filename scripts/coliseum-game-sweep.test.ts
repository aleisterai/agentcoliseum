/**
 * coliseum-game-sweep — adapter smoke for every game in the catalog.
 *
 * P1 bucket — parametric over all 14 live game adapters. For each:
 *
 *   1. propose mode=system  → match row created, status='active',
 *                              isMyTurn for alpha
 *   2. coliseum_match_state → adapter can render its state for this agent
 *   3. coliseum_match_move with {} payload → adapter rejects malformed
 *                              move (proves the move-validation pipeline
 *                              is wired, without needing per-game
 *                              first-move knowledge)
 *
 * Why system mode: it auto-accepts so we don't need a second agent's
 * credential for the accept step. Each game gets its own real DB match
 * which then sits in the lobby until the per-move clock + cron expires
 * it; that's ~60-65s of lifetime per match, negligible operator load.
 *
 * What this CATCHES:
 *   - an adapter that's been removed from REGISTRY
 *   - a propose handler crash for a specific gameType
 *   - a state serializer crash (serializeForSpectator)
 *   - a move validator that no longer rejects malformed payloads
 *   - per-game schema drift between rules.ts and the actual G object
 *
 * What this does NOT catch (P1 follow-on work):
 *   - full game playthrough → win/draw/forfeit (requires per-game
 *     scripted move sequences; deferred)
 *
 * Run:
 *   pnpm coliseum:game-sweep
 *   MCP_ORIGIN=https://www.agentcoliseum.xyz pnpm coliseum:game-sweep
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "../src/lib/db/client.js";
import { agents, owners, tierCache } from "../src/lib/db/schema.js";
import { listGames } from "../src/lib/game/registry.js";

const ORIGIN = process.env.MCP_ORIGIN ?? "http://localhost:3000";

// Derived from the live registry so the sweep covers EVERY adapter (perfect-
// and hidden-info alike — this sweep only proposes, reads state, and rejects a
// malformed move, so it never needs per-game move knowledge) and never goes
// stale as new games ship.
const GAMES = listGames().map((g) => g.id);

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

function parseToolBody<T = Record<string, unknown>>(r: JsonRpcResp): T | null {
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

interface ProposeRespMatch {
  kind: "match";
  /**
   * The propose tool wraps the created match in a nested .match
   * object — id is at body.match.id (matching the DB row's primary
   * key). isYourTurn / firstMoveDeadline live alongside it.
   */
  match?: { id: string; gameType: string; mode: string };
  matchId?: string;
  isYourTurn?: boolean;
  isMyTurn?: boolean;
  error?: string;
}
interface ProposeRespErr { error: string }

async function sweepGame(ackToken: string, gameType: string): Promise<void> {
  console.log(`\n── ${gameType} ──`);

  // 1 · propose mode=system, easiest difficulty so the bot stays out of the way
  const proposeResp = await mcpCall(ackToken, "coliseum_challenge_propose", {
    gameType,
    mode: "system",
    systemBotDifficulty: "easy",
    perMoveSeconds: 60, // give the bot the floor budget
  });
  const proposeBody = parseToolBody<ProposeRespMatch | ProposeRespErr>(proposeResp);
  if (!proposeBody) {
    fail(`${gameType} · propose`, `no body from propose tool: ${JSON.stringify(proposeResp).slice(0, 200)}`);
    return;
  }
  if ("error" in proposeBody && proposeBody.error) {
    fail(`${gameType} · propose`, `tool returned error: ${proposeBody.error.slice(0, 160)}`);
    return;
  }
  const match = proposeBody as ProposeRespMatch;
  // Accept either matchId at the top level (older shape) or the
  // nested .match.id (current shape).
  const matchId = match.match?.id ?? match.matchId;
  if (match.kind !== "match" || !matchId) {
    fail(`${gameType} · propose`, `expected kind=match with id, got: ${JSON.stringify(proposeBody).slice(0, 200)}`);
    return;
  }
  pass(`${gameType} · propose mode=system → match ${matchId.slice(0, 8)} created`);

  // 2 · match_state — adapter renders its state
  const stateResp = await mcpCall(ackToken, "coliseum_match_state", { matchId });
  const stateBody = parseToolBody<{ matchId?: string; gameType?: string; status?: string; isMyTurn?: boolean; error?: string }>(stateResp);
  if (!stateBody || stateBody.error) {
    fail(`${gameType} · state`, `state read failed: ${JSON.stringify(stateBody ?? stateResp).slice(0, 200)}`);
    return;
  }
  if (stateBody.status !== "active") {
    fail(`${gameType} · state`, `expected status=active, got ${stateBody.status}`);
    return;
  }
  if (stateBody.gameType !== gameType) {
    fail(`${gameType} · state`, `state.gameType ${stateBody.gameType} ≠ requested ${gameType}`);
    return;
  }
  pass(`${gameType} · state → active, gameType matches, isMyTurn=${stateBody.isMyTurn}`);

  // 3 · move with empty payload → expect ADAPTER-level rejection
  //     The MCP tool's outer Zod schema accepts any object as payload
  //     (z.record(z.string(), z.unknown())), so {} passes validation
  //     and is routed to the adapter's move-validator. Every game's
  //     applyMove must then reject {} as an illegal/malformed move.
  //     The exact error code varies per adapter (illegal_move,
  //     malformed_move, etc.) but the response MUST surface an error
  //     string, not a successful match advance.
  const moveResp = await mcpCall(ackToken, "coliseum_match_move", {
    matchId,
    payload: {}, // intentionally empty — adapter must reject
    reasoning: "Sweep test: submitting an empty payload to verify the per-adapter move validator rejects malformed input. This reasoning is intentional and not a real game move.",
  });
  const moveBody = parseToolBody<{ error?: string; moveAccepted?: boolean; state?: { moveCount?: number } }>(moveResp);
  if (!moveBody) {
    fail(`${gameType} · move`, `no body from move tool: ${JSON.stringify(moveResp).slice(0, 200)}`);
    return;
  }
  if (moveBody.error && /illegal|malformed|invalid|payload|move|required|missing/i.test(moveBody.error)) {
    pass(`${gameType} · empty payload → adapter rejected: ${moveBody.error.slice(0, 80)}`);
  } else if (moveBody.moveAccepted === true || (moveBody.state?.moveCount ?? 0) > 0) {
    fail(`${gameType} · move`, `empty payload ACCEPTED — validator regression: ${JSON.stringify(moveBody).slice(0, 200)}`);
  } else {
    fail(`${gameType} · move`, `unexpected move response: ${JSON.stringify(moveBody).slice(0, 200)}`);
  }
}

async function main() {
  console.log(`→ ORIGIN ${ORIGIN}`);
  console.log(`→ sweeping ${GAMES.length} game adapters`);

  const alpha = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-alpha") });
  if (!alpha) {
    console.error("alpha (mcp-duel-alpha) not seeded — run `pnpm mcp:duel` first");
    process.exit(1);
  }
  await refreshTier(alpha.ownerId!);

  for (const gameType of GAMES) {
    try {
      await sweepGame(alpha.apiKey, gameType);
    } catch (err) {
      fail(`${gameType} · uncaught`, err instanceof Error ? err.message : String(err));
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n══════════ summary ══════════`);
  console.log(`per-game sweep   ${passed}/${results.length} passed  (${GAMES.length} games × 3 checks = ${GAMES.length * 3} expected)`);
  if (failed > 0) {
    console.log(`\n${failed} CHECK(S) FAILED — at least one adapter is broken ↑`);
    process.exit(1);
  }
  console.log(`\n✓ all ${GAMES.length} adapters propose · state · reject-malformed cleanly`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
