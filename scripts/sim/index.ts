/**
 * sim — deterministic match simulator entry point.
 *
 * Run:
 *   pnpm sim --games=tic-tac-toe --matches=5
 *   pnpm sim --games=all --matches=20
 *   pnpm sim --games=tic-tac-toe,connect4 --difficulty=easy --matches=3
 *
 * Flags:
 *   --games        comma list of game ids OR 'all' (default 'tic-tac-toe')
 *   --matches      matches per game in the happy-path sweep (default 5)
 *   --difficulty   easy | medium | hard       (default easy)
 *   --opponent     system_bot                  (default — only option for v1)
 *   --twists-off   skip invalid-payload + resign-mid scenarios
 *   --concurrency  matches in flight per agent simultaneously (default 1)
 *
 * Output: scripts/sim/report-YYYY-MM-DDTHH-MM-SS.json
 *
 * Exit codes:
 *   0  all matches finished (with or without errors — the report is
 *      the deliverable, the run itself only fails on infra problems)
 *   1  failed to load test agents (auth gone)
 *   2  no scenarios selected (bad --games flag)
 */

import { join } from "node:path";
import { loadAlpha, loadBeta } from "./agents";
import { ORIGIN } from "./config";
import { ALL_GAMES, type GameId } from "./movers";
import { refreshTier } from "./prepare";
import { printSummary, writeReport } from "./report";
import { runMatch } from "./runner";
import {
  buildScenarios,
  type Scenario,
  type SimDifficulty,
} from "./scenarios";
import type { MatchRecord } from "./recorder";
import type { SimAgent } from "./agents";

interface CliArgs {
  games: GameId[];
  matches: number;
  difficulty: SimDifficulty;
  twistsOff: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) {
      args[m[1]] = m[2] ?? "true";
    }
  }
  // games
  let games: GameId[];
  const gamesArg = (args.games ?? "tic-tac-toe").toLowerCase();
  if (gamesArg === "all") {
    games = ALL_GAMES;
  } else {
    const requested = gamesArg.split(",").map((s) => s.trim());
    games = requested.filter((g): g is GameId =>
      (ALL_GAMES as readonly string[]).includes(g),
    ) as GameId[];
    const skipped = requested.filter(
      (g) => !(ALL_GAMES as readonly string[]).includes(g),
    );
    if (skipped.length > 0) {
      console.warn(
        `WARN: unknown game(s) skipped: ${skipped.join(", ")}. Known: ${ALL_GAMES.join(", ")}`,
      );
    }
  }
  // matches
  const matches = Number(args.matches ?? "5");
  // difficulty
  const diffRaw = args.difficulty ?? "easy";
  const difficulty: SimDifficulty =
    diffRaw === "medium" || diffRaw === "hard" ? diffRaw : "easy";
  // twists
  const twistsOff = args["twists-off"] === "true" || args.twistsOff === "true";
  // concurrency
  // The OLD cap was 8 (defensive). Raised to 500 so a single sim run
  // can saturate the per-bearer rate-limit ceiling.
  //
  // Real ceiling math:
  //   - Rate limit: 60 req/60s per bearer × 2 bearers = 120 ops/min
  //   - Each match: ~20-40 HTTP round-trips (state-poll + move loop)
  //   - The runner already has rate-limit-aware back-off
  //     (parses "Back off for ~Ns" from the server)
  //   - Past ~50 in-flight per bearer, you're just queueing on the
  //     server-side rate limiter — no throughput gain
  //
  // Pragmatic guidance:
  //   --concurrency=100  → ~50 in-flight per bearer, full saturation
  //   --concurrency=20   → comfortable, finishes 1000 matches in ~6h
  //   --concurrency=8    → previous default, deliberately under quota
  const concurrency = Math.max(
    1,
    Math.min(500, Number(args.concurrency ?? "1")),
  );

  return { games, matches, difficulty, twistsOff, concurrency };
}

/** Round-robin worker that pulls scenarios off a shared queue. */
async function runWorker(
  scenarioQueue: Array<{ scenario: Scenario; index: number }>,
  agent: SimAgent,
  records: MatchRecord[],
): Promise<void> {
  while (true) {
    const task = scenarioQueue.shift();
    if (!task) return;
    try {
      const rec = await runMatch({
        scenario: task.scenario,
        index: task.index,
        api: agent.api,
        agentLabel: agent.label,
        voicePackId: agent.voicePackId,
        agentId: agent.agentId,
      });
      records.push(rec);
    } catch (e) {
      // runMatch already catches and records, so an exception here
      // means a true crash. Stamp it minimally and keep going.
      console.error(`[${agent.label}] runMatch crashed:`, e);
    }
  }
}

async function main(): Promise<number> {
  const argv = parseArgs(process.argv);
  console.log(`→ sim target: ${ORIGIN}`);
  console.log(
    `→ games:       ${argv.games.join(", ") || "<none>"} (${argv.games.length})`,
  );
  console.log(`→ matches:     ${argv.matches} per game`);
  console.log(`→ difficulty:  ${argv.difficulty}`);
  console.log(`→ twists:      ${argv.twistsOff ? "off" : "on"}`);
  console.log(`→ concurrency: ${argv.concurrency}`);

  if (argv.games.length === 0) {
    console.error("ERR: no valid games selected");
    return 2;
  }

  // Load test agents -------------------------------------------------
  let alpha: SimAgent;
  try {
    alpha = await loadAlpha();
    console.log(
      `→ alpha:       ${alpha.handle} (voice=${alpha.voicePackId})`,
    );
  } catch (e) {
    console.error(
      `ERR: failed to load alpha test agent — ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  let beta: SimAgent | null = null;
  if (argv.concurrency >= 2) {
    try {
      beta = await loadBeta();
      console.log(
        `→ beta:        ${beta.handle} (voice=${beta.voicePackId})`,
      );
    } catch (e) {
      console.warn(
        `WARN: beta load failed (continuing with alpha only) — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Pre-flight: refresh tier_cache so mode=system propose passes the
  // Play-tier gate. Existing pattern from scripts/coliseum-game-sweep.
  // If the refresh fails (DATABASE_URL unset, agent has no owner row,
  // etc.) we exit early — the sim will just hammer tier_below_play
  // errors otherwise, which is a worse failure mode than a clean exit.
  const alphaTier = await refreshTier(alpha.agentId, "alpha");
  console.log(`→ tier:        ${alphaTier.detail}`);
  if (!alphaTier.ok) {
    console.error(
      `ERR: alpha tier refresh failed. Either set DATABASE_URL in .env.local OR run the sim against an environment where alpha has Play-tier without the cache hack.`,
    );
    return 1;
  }
  if (beta) {
    const betaTier = await refreshTier(beta.agentId, "beta");
    console.log(`→ tier:        ${betaTier.detail}`);
    if (!betaTier.ok) {
      console.warn(
        `WARN: beta tier refresh failed (continuing with alpha only) — ${betaTier.detail}`,
      );
    }
  }

  // Build scenario queue --------------------------------------------
  const scenarios = buildScenarios({
    games: argv.games,
    matches: argv.matches,
    difficulty: argv.difficulty,
    twistsOff: argv.twistsOff,
  });
  console.log(`→ scenarios:   ${scenarios.length}`);
  const queue: Array<{ scenario: Scenario; index: number }> = [];
  for (const sc of scenarios) {
    for (let i = 0; i < sc.count; i++) {
      queue.push({ scenario: sc, index: i });
    }
  }
  const totalRuns = queue.length;
  console.log(`→ total runs:  ${totalRuns}`);
  console.log(`──────────────────────────────────────────────────────────`);

  // Run -------------------------------------------------------------
  const records: MatchRecord[] = [];
  const workers: Promise<void>[] = [];
  workers.push(runWorker(queue, alpha, records));
  if (beta && argv.concurrency >= 2) {
    workers.push(runWorker(queue, beta, records));
  }
  for (let i = 2; i < argv.concurrency; i++) {
    // Extra workers per agent — both alpha and beta can each carry
    // multiple in-flight matches.
    if (i % 2 === 0) workers.push(runWorker(queue, alpha, records));
    else if (beta) workers.push(runWorker(queue, beta, records));
  }
  await Promise.all(workers);

  // Write report ----------------------------------------------------
  const outDir = join(process.cwd(), "scripts/sim");
  const { path, summary } = writeReport(records, ORIGIN, outDir);
  printSummary(summary);
  console.log(`→ report:      ${path}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("FATAL:", err);
    process.exit(1);
  },
);
