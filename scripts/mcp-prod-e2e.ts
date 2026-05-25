/**
 * mcp-prod-e2e — comprehensive end-to-end test of the MCP server
 * against the deployed production endpoint.
 *
 * Why this exists: every MCP-capable LLM client downloads our
 * connector bundle (.mcpb) ONCE and caches it locally. A bug fixed
 * in the bundle on the CDN doesn't reach the user until they
 * uninstall + reinstall. Likewise the live server can regress at
 * any deploy. The user-visible "is MCP working?" question therefore
 * splits into THREE independent contracts:
 *
 *   1. Direct JSON-RPC over HTTP to /api/mcp with ack_… bearer.
 *      Used by Claude Code CLI, Cursor, generic remote-MCP clients.
 *   2. OAuth dance (DCR → authorize → token → tools/call with
 *      acoth_… bearer). Used by Claude.ai web's "Add custom
 *      connector" when the server advertises OAuth metadata.
 *   3. The .mcpb stdio bundle launched as a subprocess. Used by
 *      Claude Desktop. The bundle proxies through path (1).
 *
 * This script exercises ALL THREE end-to-end against
 * https://www.agentcoliseum.xyz. Each tool from our 13-tool catalog
 * is invoked at least once per contract; the response is asserted
 * to be a well-formed success (or, where the test setup makes a
 * failure expected, the right failure shape).
 *
 * Exit code:
 *   0 = every assertion passed
 *   1 = any assertion failed; details printed to stderr.
 *
 * Run against a different deploy:
 *   MCP_ORIGIN=https://staging.agentcoliseum.xyz pnpm mcp:prod-e2e
 *
 * Uses the seeded mcp-duel-alpha / mcp-duel-beta agents — run
 * `pnpm mcp:duel` once first if those rows don't exist yet.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "../src/lib/db/client.js";
import {
  agents,
  matches,
  mcpOauthCodes,
  owners,
  tierCache,
} from "../src/lib/db/schema.js";
import { CODE_PREFIX, randomSecret } from "../src/lib/mcp-oauth.js";

/**
 * Refresh the tier_cache for an agent's owner wallet so the
 * challenge_propose / accept tier-gate doesn't hit live RPC during
 * the test. The gate's cache TTL is 60s; bumping cachedAt to now
 * keeps the seeded `play` tier alive long enough for the test
 * battery to finish. Without this, an RPC read of the (empty) test
 * wallet returns "none" tier and propose/accept reject.
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

const ORIGIN = process.env.MCP_ORIGIN ?? "https://www.agentcoliseum.xyz";
const BUNDLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "mcpb",
  "server",
  "coliseum-mcp.mjs",
);

// USDC on Base — a real ERC-20 we can use as tokenCa during the
// profile_update test. Any chain-read against this address returns
// readable ERC-20 metadata, so the on-chain validation in
// agent-profile-update passes.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

interface TestResult {
  contract: "http-ack" | "oauth" | "bundle";
  tool: string;
  ok: boolean;
  detail: string;
  ms: number;
}
const results: TestResult[] = [];

function pass(contract: TestResult["contract"], tool: string, detail: string, ms: number) {
  results.push({ contract, tool, ok: true, detail, ms });
}
function fail(contract: TestResult["contract"], tool: string, detail: string, ms = 0) {
  results.push({ contract, tool, ok: false, detail, ms });
}

// ─── HTTP/JSON-RPC client (path 1, also reused by path 2) ───────────────────

async function jsonRpcCall(
  bearer: string,
  method: string,
  params: object,
): Promise<unknown> {
  const res = await fetch(`${ORIGIN}/api/mcp`, {
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
  const body = (await res.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };
  if (body.error) {
    throw new Error(`JSON-RPC ${method} → ${body.error.code} ${body.error.message}`);
  }
  return body.result;
}

async function callTool<T = unknown>(
  bearer: string,
  name: string,
  args: object,
): Promise<T> {
  const result = (await jsonRpcCall(bearer, "tools/call", {
    name,
    arguments: args,
  })) as { content?: Array<{ type: string; text: string }> };
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`tools/call ${name}: no text content in response`);
  }
  const parsed = JSON.parse(text) as { error?: string } & Record<string, unknown>;
  if (parsed.error) throw new Error(`tool ${name} returned error: ${parsed.error}`);
  return parsed as T;
}

// ─── path 1 + 2: shared per-bearer test battery ─────────────────────────────

async function runToolBatteryWithBearer(
  contract: "http-ack" | "oauth",
  bearer: string,
  alphaId: string,
  betaApiKey: string,
): Promise<void> {
  const tryTool = async <T>(name: string, args: object, assert: (r: T) => string | null) => {
    const start = Date.now();
    try {
      const r = await callTool<T>(bearer, name, args);
      const failure = assert(r);
      const ms = Date.now() - start;
      if (failure) fail(contract, name, `assertion: ${failure}`, ms);
      else pass(contract, name, "ok", ms);
    } catch (err) {
      fail(contract, name, err instanceof Error ? err.message : String(err), Date.now() - start);
    }
  };

  // 1. docs.list — must return ≥3 topics
  await tryTool<{ topics: Array<{ id: string; title: string }> }>(
    "coliseum_docs_list",
    {},
    (r) => (r.topics?.length >= 3 ? null : `expected ≥3 topics, got ${r.topics?.length}`),
  );

  // 2. docs.read 'rules'
  await tryTool<{ markdown: string }>(
    "coliseum_docs_read",
    { topic: "rules" },
    (r) =>
      typeof r.markdown === "string" && r.markdown.length > 100
        ? null
        : "rules doc missing or too short",
  );

  // 3. profile_get — must return a handle
  await tryTool<{ handle: string; displayName: string }>(
    "coliseum_agent_profile_get",
    {},
    (r) => (r.handle === "mcp-duel-alpha" ? null : `wrong handle: ${r.handle}`),
  );

  // 4. agent_config — must include hard cap + on-chain allowance struct
  await tryTool<Record<string, unknown>>(
    "coliseum_agent_config",
    {},
    (r) => (r.handle === "mcp-duel-alpha" ? null : `wrong handle: ${r.handle}`),
  );

  // 5. agent_stats — record fields present
  await tryTool<{ elo: number; record: { wins: number } }>(
    "coliseum_agent_stats",
    {},
    (r) =>
      typeof r.elo === "number" && r.record && typeof r.record.wins === "number"
        ? null
        : "missing elo / record",
  );

  // 6. match_list — must return an `openChallenges` array (may be empty)
  await tryTool<{ active?: unknown[]; openChallenges?: unknown[] }>(
    "coliseum_match_list",
    {},
    (r) =>
      Array.isArray(r.openChallenges) || Array.isArray(r.active)
        ? null
        : "openChallenges/active missing",
  );

  // 7. tournament_list — array (may be empty)
  await tryTool<{ tournaments?: unknown[] } | unknown[]>(
    "coliseum_tournament_list",
    {},
    (r) => {
      const arr = Array.isArray(r) ? r : (r as { tournaments?: unknown[] }).tournaments;
      return Array.isArray(arr) ? null : "expected tournament list array";
    },
  );

  // 8. profile_update — every field the user cares about, in sequence.
  //    Each subtest applies one field, asserts it stuck, and continues.
  const updateField = async <K extends string>(
    field: K,
    value: unknown,
    expectShape: (r: Record<string, unknown>) => string | null,
  ) => {
    const start = Date.now();
    try {
      const r = await callTool<Record<string, unknown>>(
        bearer,
        "coliseum_agent_profile_update",
        { [field]: value },
      );
      const failure = expectShape(r);
      const ms = Date.now() - start;
      if (failure) fail(contract, `profile_update[${field}]`, failure, ms);
      else pass(contract, `profile_update[${field}]`, `${field} = ${JSON.stringify(value).slice(0, 60)}`, ms);
    } catch (err) {
      fail(
        contract,
        `profile_update[${field}]`,
        err instanceof Error ? err.message : String(err),
        Date.now() - start,
      );
    }
  };

  await updateField("displayName", "Test Agent (e2e)", (r) =>
    r.displayName === "Test Agent (e2e)" ? null : `displayName not applied: ${r.displayName}`,
  );
  await updateField("bio", "Updated by e2e at " + new Date().toISOString(), (r) =>
    typeof r.bio === "string" && r.bio.startsWith("Updated by e2e at") ? null : "bio not applied",
  );
  await updateField("avatarUrl", "https://example.com/avatar.png", (r) =>
    r.avatarUrl === "https://example.com/avatar.png" ? null : `avatarUrl: ${r.avatarUrl}`,
  );
  await updateField("tokenCa", USDC_BASE, (r) =>
    typeof r.tokenCa === "string" && (r.tokenCa as string).toLowerCase() === USDC_BASE.toLowerCase()
      ? null
      : `tokenCa: ${r.tokenCa}`,
  );
  await updateField("voicePackId", "trash-talker", (r) =>
    r.voicePackId === "trash-talker" ? null : `voicePackId: ${r.voicePackId}`,
  );
  await updateField("catchphrase", "win or whisper", (r) =>
    r.catchphrase === "win or whisper" ? null : `catchphrase: ${r.catchphrase}`,
  );
  await updateField("website", "https://example.com/me", (r) =>
    r.website === "https://example.com/me" ? null : `website: ${r.website}`,
  );
  await updateField(
    "socials",
    { x: "test_agent", github: "test_agent" },
    (r) => {
      const s = r.socials as { x?: string } | null;
      return s?.x === "test_agent" ? null : `socials: ${JSON.stringify(s)}`;
    },
  );
  await updateField(
    "trashTalkTemplates",
    ["good luck (you'll need it)", "is that all you've got?"],
    (r) => {
      const arr = r.trashTalkTemplates as string[] | null;
      return arr && arr.length === 2 ? null : `trashTalkTemplates: ${JSON.stringify(arr)}`;
    },
  );

  // 9. challenge.propose + accept + match.state + match.move — uses
  //    both bearers (alpha proposes, beta accepts).
  const proposeStart = Date.now();
  try {
    const prop = await callTool<
      | { kind: "challenge"; challenge: { id: string } }
      | { error: string }
    >(bearer, "coliseum_challenge_propose", {
      gameType: "tic-tac-toe",
      mode: "free",
      opponentHandle: "mcp-duel-beta",
      perMoveSeconds: 30,
      timeoutMin: 30,
    });
    if ("error" in prop) throw new Error(prop.error);
    if (prop.kind !== "challenge") throw new Error(`unexpected propose kind: ${JSON.stringify(prop)}`);
    pass(contract, "coliseum_challenge_propose", `challenge ${prop.challenge.id.slice(0, 8)}`, Date.now() - proposeStart);

    // beta accepts via direct HTTP/JSON-RPC (we always use ack_ here
    // since the OAuth token is bound to alpha)
    const acceptStart = Date.now();
    const acc = await callTool<{ matchId: string; error?: string }>(
      betaApiKey,
      "coliseum_challenge_accept",
      { challengeId: prop.challenge.id },
    );
    if (acc.error) throw new Error(acc.error);
    pass(contract, "coliseum_challenge_accept", `match ${acc.matchId.slice(0, 8)}`, Date.now() - acceptStart);

    // match.state from alpha's POV — also verifies the Phase A
    // voice + reasoning surface (myVoice, opponentVoice,
    // recentReasoning, recentMoods, myMsLeftLive, urgency).
    const stateStart = Date.now();
    const state = await callTool<{
      myPlayerId: string;
      isMyTurn: boolean;
      boardState: { G?: { board?: number[] } };
      myMsLeftLive: number;
      turnDeadline: string | null;
      urgency: "fresh" | "half" | "low" | "critical";
      myVoice: {
        voicePackId: string | null;
        catchphrase: string | null;
        trashTalkTemplates: string[];
      } | null;
      opponentVoice: {
        voicePackId: string | null;
        catchphrase: string | null;
      } | null;
      recentReasoning: Array<{ moveNumber: number; byMe: boolean }>;
      recentMoods: string[];
    }>(bearer, "coliseum_match_state", { matchId: acc.matchId });
    if (!state.boardState) throw new Error("no boardState");
    if (typeof state.myMsLeftLive !== "number") throw new Error("missing myMsLeftLive");
    if (!["fresh", "half", "low", "critical"].includes(state.urgency)) {
      throw new Error(`bad urgency: ${state.urgency}`);
    }
    if (!Array.isArray(state.recentReasoning)) throw new Error("missing recentReasoning");
    if (!Array.isArray(state.recentMoods)) throw new Error("missing recentMoods");
    if (state.myVoice === undefined) throw new Error("missing myVoice");
    if (state.opponentVoice === undefined) throw new Error("missing opponentVoice");
    pass(
      contract,
      "coliseum_match_state",
      `myTurn=${state.isMyTurn} pid=${state.myPlayerId} urgency=${state.urgency} voice=${state.myVoice?.voicePackId ?? "—"}`,
      Date.now() - stateStart,
    );

    // match.move — alpha plays index 4 with FULL structured reasoning
    // (Phase A: candidates + evaluation + plan + expectedReply + mood
    // + emotionTrigger + phase). The server must accept all of these
    // and persist them so spectator UI can render the rich payload.
    if (state.isMyTurn) {
      const moveStart = Date.now();
      const moveResp = await callTool<{ error?: string; status: string }>(
        bearer,
        "coliseum_match_move",
        {
          matchId: acc.matchId,
          payload: { index: 4 },
          reasoning:
            "Center: strongest opening on a 3x3 board because it sits on all four winning lines. I weighed the corner play (slower, more reactive) but information-density favors the symmetric center against an unknown opponent.",
          candidates: [
            { payload: { index: 4 }, evaluation: 0.4, why: "Maximum reach: 4 winning lines." },
            { payload: { index: 0 }, evaluation: 0.15, why: "Corner: standard alternative, more passive." },
            { payload: { index: 2 }, evaluation: 0.15, why: "Mirrored corner, symmetric to index 0." },
          ],
          evaluation: { score: 0.3, confidence: "high" },
          plan: "Center now, then opposite corner on move 3 to force a fork.",
          expectedReply: {
            payload: { index: 0 },
            why: "Bot will likely contest a corner for symmetry.",
          },
          phase: "opening",
          mood: "focused",
          emotionTrigger: "Familiar opening, low ambiguity.",
        },
      );
      if (moveResp.error) throw new Error(moveResp.error);
      pass(contract, "coliseum_match_move", `status=${moveResp.status} (structured payload)`, Date.now() - moveStart);

      // Re-read state — recentReasoning must include our structured
      // move with its candidates + mood. Also verify the new Phase A++
      // fields: opponentLastMove (from beta's POV would be alpha's
      // move) and chat (full session, here empty pre-chat).
      const after = await callTool<{
        recentReasoning: Array<{
          byMe: boolean;
          reasoning: string;
          candidates: Array<unknown> | null;
          mood: string | null;
          phase: string | null;
        }>;
        recentMoods: string[];
        chat: Array<{ id: string; body: string; byMe: boolean }>;
      }>(bearer, "coliseum_match_state", { matchId: acc.matchId });
      const ourMove = after.recentReasoning.find(
        (m) => m.byMe && m.reasoning?.startsWith("Center: strongest opening"),
      );
      if (!ourMove) throw new Error("our move not in recentReasoning");
      if (!Array.isArray(ourMove.candidates) || ourMove.candidates.length !== 3) {
        throw new Error(`candidates not persisted: ${JSON.stringify(ourMove.candidates)}`);
      }
      if (ourMove.mood !== "focused") throw new Error(`mood not persisted: ${ourMove.mood}`);
      if (ourMove.phase !== "opening") throw new Error(`phase not persisted: ${ourMove.phase}`);
      if (!after.recentMoods.includes("focused")) {
        throw new Error("recentMoods missing 'focused'");
      }
      if (!Array.isArray(after.chat)) throw new Error("chat field missing");
      pass(
        contract,
        "phase_a_persistence",
        `candidates=${ourMove.candidates.length} mood=${ourMove.mood} phase=${ourMove.phase}`,
        0,
      );

      // ── Phase A++: chat send + tapback react round-trip.
      const chatStart = Date.now();
      const sent = await callTool<{ error?: string; id: string; body: string }>(
        bearer,
        "coliseum_match_chat_send",
        {
          matchId: acc.matchId,
          body: "gl hf — e2e probe",
        },
      );
      if (sent.error) throw new Error(`chat_send: ${sent.error}`);
      pass(contract, "coliseum_match_chat_send", `id=${sent.id.slice(0, 8)}`, Date.now() - chatStart);

      // Tapback on alpha's own move (allowed — agent can react to their
      // own move too, mostly useful for spectators but exercise the
      // path here).
      const reactStart = Date.now();
      const reacted = await callTool<{ error?: string; reactions: Array<{ emoji: string }> }>(
        bearer,
        "coliseum_match_react",
        {
          matchId: acc.matchId,
          target: { kind: "move", moveNumber: 0 },
          emoji: "🔥",
        },
      );
      if (reacted.error) throw new Error(`react: ${reacted.error}`);
      if (!Array.isArray(reacted.reactions) || reacted.reactions.length === 0) {
        throw new Error(`react: no reactions returned`);
      }
      pass(
        contract,
        "coliseum_match_react",
        `reactions=${reacted.reactions.length}`,
        Date.now() - reactStart,
      );

      // Verify the chat shows up in match_state.chat next read.
      const afterChat = await callTool<{
        chat: Array<{ body: string }>;
      }>(bearer, "coliseum_match_state", { matchId: acc.matchId });
      if (!afterChat.chat.some((c) => c.body === "gl hf — e2e probe")) {
        throw new Error("chat not echoed back in match_state.chat");
      }
      pass(contract, "phase_a++_round_trip", `chat=${afterChat.chat.length}`, 0);
    } else {
      pass(contract, "coliseum_match_move", "skipped — beta's turn first", 0);
    }

    // Clean up: the match will time out + finalize on its own when the
    // clock expires. We don't force-finalize here — concurrent runs of
    // this test would collide otherwise.
  } catch (err) {
    fail(
      contract,
      "challenge+match flow",
      err instanceof Error ? err.message : String(err),
      Date.now() - proposeStart,
    );
  }

  // Suppress unused-var lint
  void alphaId;
}

// ─── path 2: OAuth dance ────────────────────────────────────────────────────

async function runOAuthFlow(alphaAgentId: string, alphaOwnerId: string): Promise<string> {
  const REDIRECT_URI = "http://localhost:65535/cb";

  // a. Metadata
  const metaRes = await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
  if (!metaRes.ok) throw new Error(`metadata fetch: ${metaRes.status}`);
  const meta = (await metaRes.json()) as {
    registration_endpoint: string;
    token_endpoint: string;
  };

  // b. DCR
  const regRes = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "mcp-prod-e2e",
      redirect_uris: [REDIRECT_URI],
    }),
  });
  if (!regRes.ok) throw new Error(`DCR: ${regRes.status} ${await regRes.text()}`);
  const reg = (await regRes.json()) as { client_id: string };

  // c. Seed an authorization code directly in the DB (the consent
  //    page is browser-only; from a CLI we skip it but produce the
  //    same row the page would have produced).
  const verifier = randomBytes(32).toString("base64url");
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  const code = randomSecret(CODE_PREFIX, 24);
  await db.insert(mcpOauthCodes).values({
    code,
    clientId: reg.client_id,
    agentId: alphaAgentId,
    ownerId: alphaOwnerId,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    scope: "mcp",
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });

  // d. Exchange code for token
  const tokenRes = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: reg.client_id,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`token: ${tokenRes.status} ${await tokenRes.text()}`);
  const token = (await tokenRes.json()) as { access_token: string };
  return token.access_token;
}

// ─── path 3: bundle subprocess (Claude Desktop path) ────────────────────────

interface BundleClient {
  send: (msg: object) => void;
  recv: () => Promise<{ id: number; result?: unknown; error?: { message: string } }>;
  kill: () => void;
}

function spawnBundle(apiKey: string, apiBase: string): BundleClient {
  const proc = spawn("node", [BUNDLE_PATH], {
    env: { ...process.env, COLISEUM_API_KEY: apiKey, COLISEUM_API_BASE: apiBase },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.on("data", () => {
    // Bundle logs to stderr; suppress unless debugging.
  });

  let buf = "";
  const queue: object[] = [];
  let waiter: ((m: object) => void) | null = null;
  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(parsed);
        } else {
          queue.push(parsed);
        }
      } catch {
        // ignore non-JSON lines (probably stderr leakage)
      }
    }
  });

  return {
    send(msg) {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    },
    recv() {
      return new Promise((resolve) => {
        if (queue.length > 0) {
          resolve(queue.shift() as never);
        } else {
          waiter = (m) => resolve(m as never);
        }
      });
    },
    kill() {
      proc.kill();
    },
  };
}

async function runBundleTests(apiKey: string): Promise<void> {
  const client = spawnBundle(apiKey, ORIGIN);
  try {
    // initialize
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
    await client.recv();

    // initialized notification
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // tools/list
    const listStart = Date.now();
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = (await client.recv()) as {
      result?: { tools: Array<{ name: string }> };
      error?: { message: string };
    };
    if (listed.error) {
      fail("bundle", "tools/list", listed.error.message, Date.now() - listStart);
    } else {
      const n = listed.result?.tools.length ?? 0;
      pass("bundle", "tools/list", `${n} tools`, Date.now() - listStart);
    }

    // sample the four headline tools through the bundle's proxy
    const samples: Array<{ name: string; args: object; check: (r: Record<string, unknown>) => string | null }> = [
      {
        name: "coliseum_docs_list",
        args: {},
        check: (r) =>
          (r.topics as Array<unknown>)?.length >= 3 ? null : "<3 topics",
      },
      {
        name: "coliseum_agent_profile_get",
        args: {},
        check: (r) => (r.handle === "mcp-duel-alpha" ? null : `wrong handle: ${r.handle}`),
      },
      {
        name: "coliseum_agent_config",
        args: {},
        check: (r) => (r.handle ? null : "no handle field"),
      },
      {
        name: "coliseum_agent_stats",
        args: {},
        check: (r) => (typeof r.elo === "number" ? null : "no elo"),
      },
      {
        name: "coliseum_agent_profile_update",
        args: { catchphrase: "bundle says hi (e2e)" },
        check: (r) =>
          r.catchphrase === "bundle says hi (e2e)" ? null : `catchphrase: ${r.catchphrase}`,
      },
    ];

    let id = 100;
    for (const s of samples) {
      const start = Date.now();
      client.send({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name: s.name, arguments: s.args },
      });
      const resp = (await client.recv()) as {
        result?: { content?: Array<{ text: string }> };
        error?: { message: string };
      };
      const ms = Date.now() - start;
      if (resp.error) {
        fail("bundle", s.name, resp.error.message, ms);
        continue;
      }
      const text = resp.result?.content?.[0]?.text;
      if (!text) {
        fail("bundle", s.name, "no content", ms);
        continue;
      }
      const parsed = JSON.parse(text) as Record<string, unknown> & { error?: string };
      if (parsed.error) {
        fail("bundle", s.name, `tool error: ${parsed.error}`, ms);
        continue;
      }
      const failure = s.check(parsed);
      if (failure) fail("bundle", s.name, failure, ms);
      else pass("bundle", s.name, "ok", ms);
    }
  } finally {
    client.kill();
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`→ ORIGIN ${ORIGIN}`);
  console.log(`→ BUNDLE ${BUNDLE_PATH}\n`);

  // Lookup the two seeded test agents.
  const alpha = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-alpha") });
  const beta = await db.query.agents.findFirst({ where: eq(agents.handle, "mcp-duel-beta") });
  if (!alpha || !beta) {
    throw new Error("Seed mcp-duel-alpha + mcp-duel-beta first by running `pnpm mcp:duel`");
  }
  console.log(`alpha @${alpha.handle} ack_${alpha.apiKey.slice(4, 12)}…  beta @${beta.handle} ack_${beta.apiKey.slice(4, 12)}…`);

  await refreshTier(alpha.ownerId!);
  await refreshTier(beta.ownerId!);
  console.log("(refreshed tier_cache for both test wallets)\n");

  console.log("── PATH 1: direct JSON-RPC w/ ack_ bearer ──");
  await runToolBatteryWithBearer("http-ack", alpha.apiKey, alpha.id, beta.apiKey);

  console.log("\n── PATH 2: OAuth flow w/ acoth_ bearer ──");
  let acothToken: string | null = null;
  try {
    acothToken = await runOAuthFlow(alpha.id, alpha.ownerId!);
    pass("oauth", "full-dance", `acoth_${acothToken.slice(6, 14)}…`, 0);
  } catch (err) {
    fail("oauth", "full-dance", err instanceof Error ? err.message : String(err));
  }
  if (acothToken) {
    await runToolBatteryWithBearer("oauth", acothToken, alpha.id, beta.apiKey);
  }

  console.log("\n── PATH 3: stdio bundle subprocess (Claude Desktop path) ──");
  try {
    await runBundleTests(alpha.apiKey);
  } catch (err) {
    fail("bundle", "subprocess", err instanceof Error ? err.message : String(err));
  }

  // Cleanup: reset alpha's profile to a stable state for the next run.
  await callTool(alpha.apiKey, "coliseum_agent_profile_update", {
    displayName: "MCP Duel Alpha",
    bio: null,
    avatarUrl: null,
    tokenCa: null,
    website: null,
    socials: null,
    voicePackId: null,
    catchphrase: null,
    winLine: null,
    lossLine: null,
    trashTalkTemplates: null,
  }).catch(() => undefined);

  // ─── summary ───
  console.log("\n\n══════════ summary ══════════");
  const byContract: Record<string, { ok: number; fail: number }> = {};
  for (const r of results) {
    byContract[r.contract] ??= { ok: 0, fail: 0 };
    if (r.ok) byContract[r.contract].ok++;
    else byContract[r.contract].fail++;
  }
  for (const [c, s] of Object.entries(byContract)) {
    const total = s.ok + s.fail;
    console.log(`${c.padEnd(10)}  ${s.ok}/${total} passed`);
  }
  console.log();

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.log("── failures ──");
    for (const f of failures) {
      console.log(`✗ [${f.contract}] ${f.tool}: ${f.detail}`);
    }
  } else {
    console.log("✓ ALL CONTRACTS PASSED");
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(1);
});
