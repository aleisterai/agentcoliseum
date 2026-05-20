/**
 * mcp-duel — drive a single tic-tac-toe match between two real agents
 * over the live /api/mcp endpoint. Exercises the entire MCP path
 * end-to-end: Bearer auth, JSON-RPC envelope, tool dispatch, the
 * challenge.propose → challenge.accept → match.state → match.move
 * cycle, and the new mandatory-reasoning rule.
 *
 * Setup the script does on first run (idempotent):
 *   1. Synthesizes two owner rows (`mcp-duel-alpha-owner`,
 *      `mcp-duel-beta-owner`) with deterministic wallet addresses.
 *   2. Seeds the `tier_cache` row for both wallets to `play` tier
 *      (20M ALEISTER's worth of wei) so the tier-gate in
 *      challenge.propose / challenge.accept doesn't hit the live RPC
 *      and reject the local test wallets. The cache is checked
 *      first; the RPC only fires when the cached row is older than
 *      60s, so this is enough to bypass the gate.
 *   3. Creates the two agent rows with fresh `ack_…` apiKeys.
 *
 * Then it:
 *   a. POSTs `coliseum.challenge.propose` from alpha (mode=free,
 *      tic-tac-toe, opponentHandle=beta, 30s/move).
 *   b. POSTs `coliseum.challenge.accept` from beta with the
 *      challenge id.
 *   c. Logs the spectator URL (`/match/{id}`) and starts the duel
 *      loop. Each tick: read match.state with both bearers, the
 *      agent whose turn it is picks a move with a heuristic and
 *      calls match.move with a generated reasoning string.
 *   d. Exits cleanly when the match status flips off `active`.
 *
 * Run:
 *   pnpm mcp:duel               # defaults to http://localhost:3000
 *   MCP_URL=https://… pnpm mcp:duel
 *
 * The script does NOT touch the bot harness — pick handles separately
 * (`mcp-duel-alpha`, `mcp-duel-beta`) and run alongside `dev:bots` if
 * you want background activity.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "../src/lib/db/client.js";
import { agents, owners, tierCache } from "../src/lib/db/schema.js";
import { generateApiKey } from "../src/lib/auth.js";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3000/api/mcp";
const GAME_TYPE = "tic-tac-toe";
const PER_MOVE_SECONDS = 30;

// Deterministic test wallets — these aren't real wallets on Base
// mainnet; they exist only to satisfy the `owners.walletAddress` NOT
// NULL UNIQUE constraint and the tier-cache primary key. We pass them
// through viem's getAddress() to get the EIP-55 checksum form so
// later cache lookups (`requireTier` checksums internally) hit the
// same primary key we wrote.
const ALPHA_WALLET = getAddress("0x000000000000000000000000000000000000aaaa");
const BETA_WALLET = getAddress("0x000000000000000000000000000000000000bbbb");

// Hardcoded `play`-tier balance to drop into tier_cache. 20M ALEISTER
// in wei (18 decimals).
const PLAY_TIER_BALANCE_WEI = (20_000_000n * 10n ** 18n).toString();

interface SeedAgent {
  id: string;
  handle: string;
  displayName: string;
  apiKey: string;
}

async function ensureAgent(opts: {
  handle: string;
  displayName: string;
  walletAddress: string;
}): Promise<SeedAgent> {
  // Owner: insert if missing.
  let owner = await db.query.owners.findFirst({
    where: eq(owners.walletAddress, opts.walletAddress),
  });
  if (!owner) {
    [owner] = await db
      .insert(owners)
      .values({
        walletAddress: opts.walletAddress,
        apiKey: generateApiKey(),
      })
      .returning();
  }

  // Tier cache: upsert so the tier gate skips the RPC.
  await db
    .insert(tierCache)
    .values({
      walletAddress: opts.walletAddress,
      balanceWei: PLAY_TIER_BALANCE_WEI,
      tier: "play",
      cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tierCache.walletAddress,
      set: {
        balanceWei: PLAY_TIER_BALANCE_WEI,
        tier: "play",
        cachedAt: new Date(),
      },
    });

  // Agent: insert if missing, otherwise reuse + clear any recall state.
  // If a prior failed run left the agent pointing at an owner with an
  // invalid walletAddress, repoint it to the freshly-validated owner —
  // otherwise the tier-gate keeps reading the bad address.
  let agent = await db.query.agents.findFirst({ where: eq(agents.handle, opts.handle) });
  if (!agent) {
    [agent] = await db
      .insert(agents)
      .values({
        ownerId: owner.id,
        handle: opts.handle,
        displayName: opts.displayName,
        apiKey: generateApiKey(),
        elo: 1200,
      })
      .returning();
  } else {
    const patch: Partial<typeof agents.$inferInsert> = {};
    if (agent.ownerId !== owner.id) patch.ownerId = owner.id;
    if (agent.recalledAt) {
      patch.recalledAt = null;
      patch.recalledBy = null;
      patch.recallReason = null;
    }
    if (Object.keys(patch).length > 0) {
      [agent] = await db.update(agents).set(patch).where(eq(agents.id, agent.id)).returning();
    }
  }

  return {
    id: agent.id,
    handle: agent.handle,
    displayName: agent.displayName,
    apiKey: agent.apiKey,
  };
}

/**
 * One JSON-RPC call against /api/mcp. Throws on transport/parse error;
 * tool-level errors come back as { error } in the unwrapped result so
 * the duel loop can decide whether to retry.
 */
async function mcpRpc(bearer: string, method: string, params: object): Promise<unknown> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method,
      params,
    }),
  });
  if (!res.ok && res.status !== 200) {
    throw new Error(`HTTP ${res.status} from ${MCP_URL}`);
  }
  const json = (await res.json()) as {
    result?: { content?: Array<{ type: string; text: string }> } | unknown;
    error?: { code: number; message: string };
  };
  if (json.error) {
    throw new Error(`MCP rpc ${method} → ${json.error.code} ${json.error.message}`);
  }
  return json.result;
}

async function callTool<T = unknown>(bearer: string, name: string, args: object): Promise<T> {
  const result = (await mcpRpc(bearer, "tools/call", {
    name,
    arguments: args,
  })) as { content?: Array<{ type: string; text: string }> };
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`tool ${name} returned no content`);
  }
  return JSON.parse(text) as T;
}

// ───────────────────────── tic-tac-toe heuristic ─────────────────────────

type Board = number[]; // 9 cells, 0=empty, 1=X(p0), 2=O(p1)

const WIN_LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
  [0, 4, 8], [2, 4, 6],             // diagonals
];

function findWinningMove(board: Board, mark: 1 | 2): number | null {
  for (const line of WIN_LINES) {
    const cells = line.map((i) => board[i]);
    const mine = cells.filter((c) => c === mark).length;
    const empty = cells.filter((c) => c === 0).length;
    if (mine === 2 && empty === 1) {
      return line[cells.findIndex((c) => c === 0)];
    }
  }
  return null;
}

function pickTttMove(
  board: Board,
  myMark: 1 | 2,
): { index: number; reasoning: string } {
  const oppMark = myMark === 1 ? 2 : 1;

  // 1. Take the win if it's there.
  const win = findWinningMove(board, myMark);
  if (win != null) {
    return {
      index: win,
      reasoning: `Playing index ${win} completes my row/column/diagonal — winning move.`,
    };
  }

  // 2. Block opponent's winning threat.
  const block = findWinningMove(board, oppMark);
  if (block != null) {
    return {
      index: block,
      reasoning: `Blocking opponent's three-in-a-row at index ${block}; ignoring this loses next turn.`,
    };
  }

  // 3. Center if open — strongest TTT square.
  if (board[4] === 0) {
    return {
      index: 4,
      reasoning: "Claiming the center (4) — appears in 4 of 8 winning lines, strongest square.",
    };
  }

  // 4. Corner — second-best, sets up two-line forks.
  for (const c of [0, 2, 6, 8]) {
    if (board[c] === 0) {
      return {
        index: c,
        reasoning: `Taking corner ${c} — corners participate in 3 winning lines each and can set up a fork.`,
      };
    }
  }

  // 5. Whatever edge is left.
  for (const e of [1, 3, 5, 7]) {
    if (board[e] === 0) {
      return {
        index: e,
        reasoning: `Edge ${e} is the only square left; holding tempo.`,
      };
    }
  }

  throw new Error("no legal moves remain");
}

// ─────────────────────────── duel orchestration ───────────────────────────

interface MatchStateResult {
  status: "active" | "completed" | "abandoned";
  isMyTurn: boolean;
  moveCount: number;
  myPlayerId: "0" | "1";
  boardState: { G: { board: Board } } | { board: Board } | unknown;
  winnerAgentId: string | null;
  resultReason: string | null;
}

function extractBoard(state: MatchStateResult): Board {
  // applyMove writes the full boardgame.io state to matches.state, so
  // boardState wraps the G under `.G`. Tolerate both shapes for safety.
  const s = state.boardState as { G?: { board?: Board }; board?: Board } | null;
  if (s?.G?.board) return s.G.board;
  if (s?.board) return s.board;
  throw new Error(`unknown board shape: ${JSON.stringify(state.boardState).slice(0, 120)}`);
}

async function main() {
  console.log("→ ensuring duel agents...");
  const alpha = await ensureAgent({
    handle: "mcp-duel-alpha",
    displayName: "MCP Duel Alpha",
    walletAddress: ALPHA_WALLET,
  });
  const beta = await ensureAgent({
    handle: "mcp-duel-beta",
    displayName: "MCP Duel Beta",
    walletAddress: BETA_WALLET,
  });
  console.log(`  alpha id=${alpha.id.slice(0, 8)} bearer=${alpha.apiKey.slice(0, 12)}…`);
  console.log(`  beta  id=${beta.id.slice(0, 8)} bearer=${beta.apiKey.slice(0, 12)}…`);

  console.log("\n→ verifying MCP endpoint via tools/list…");
  await mcpRpc(alpha.apiKey, "tools/list", {});
  console.log("  OK — auth + dispatch round-trip clean");

  console.log(`\n→ alpha proposing challenge (free, ${GAME_TYPE}, ${PER_MOVE_SECONDS}s/move, opponent=@${beta.handle})…`);
  const propose = await callTool<
    | { kind: "challenge"; challenge: { id: string } }
    | { kind: "match"; matchId: string }
    | { error: string }
  >(alpha.apiKey, "coliseum.challenge.propose", {
    gameType: GAME_TYPE,
    mode: "free",
    opponentHandle: beta.handle,
    perMoveSeconds: PER_MOVE_SECONDS,
    timeoutMin: 30,
  });
  if ("error" in propose) throw new Error(`propose failed: ${propose.error}`);
  if (propose.kind !== "challenge") {
    throw new Error(`unexpected propose kind: ${JSON.stringify(propose)}`);
  }
  const challengeId = propose.challenge.id;
  console.log(`  challenge id ${challengeId.slice(0, 8)}`);

  console.log(`\n→ beta accepting…`);
  const accepted = await callTool<{ matchId: string; error?: string }>(
    beta.apiKey,
    "coliseum.challenge.accept",
    { challengeId },
  );
  if (accepted.error) throw new Error(`accept failed: ${accepted.error}`);
  const matchId = accepted.matchId;
  console.log(`  match id ${matchId.slice(0, 8)}`);
  console.log(`\n📺 watch live: http://localhost:3000/match/${matchId}\n`);

  // Duel loop. Each iteration checks state from both bearers (the
  // server returns whose turn it is from each agent's POV); whoever
  // is on move plays.
  const bearers = { [alpha.id]: alpha.apiKey, [beta.id]: beta.apiKey };
  const handles = { [alpha.id]: alpha.handle, [beta.id]: beta.handle };
  let safety = 0;
  while (safety++ < 30) {
    let moved = false;
    for (const me of [alpha, beta]) {
      const state = await callTool<MatchStateResult>(bearers[me.id], "coliseum.match.state", {
        matchId,
      });
      if (state.status !== "active") {
        console.log(
          `\n🏁 match complete after ${state.moveCount} moves — status=${state.status}, reason=${state.resultReason ?? "—"}`,
        );
        if (state.winnerAgentId) {
          const winnerHandle = handles[state.winnerAgentId] ?? state.winnerAgentId.slice(0, 8);
          console.log(`   winner: @${winnerHandle}`);
        } else {
          console.log("   draw");
        }
        console.log(`\n📺 final: http://localhost:3000/match/${matchId}`);
        return;
      }
      if (!state.isMyTurn) continue;

      const board = extractBoard(state);
      const myMark = state.myPlayerId === "0" ? 1 : 2;
      const { index, reasoning } = pickTttMove(board, myMark);
      console.log(`  @${me.handle} → idx ${index}  | ${reasoning}`);

      const r = await callTool<{ error?: string; finalized?: boolean }>(
        bearers[me.id],
        "coliseum.match.move",
        {
          matchId,
          payload: { index },
          reasoning,
          thinkingMs: 400 + Math.floor(Math.random() * 1600),
        },
      );
      if (r.error) {
        console.error(`   ! move rejected for @${me.handle}: ${r.error}`);
      }
      moved = true;
      // Pace the moves so the spectator UI has a chance to render +
      // realtime broadcasts get a clean event boundary.
      await new Promise((r) => setTimeout(r, 1200));
      break; // restart the for-loop so we re-read state each iteration
    }
    if (!moved) {
      // Neither side reported isMyTurn — give the server a beat to
      // settle, then retry.
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log("\n⚠ safety cap reached (30 loop iterations) — bailing out.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nmcp-duel failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
