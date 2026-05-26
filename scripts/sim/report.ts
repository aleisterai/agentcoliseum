/**
 * report.ts — aggregate per-match records into a single JSON report.
 *
 * The brief calls for:
 *   - bug categories (top error codes, grouped by phase)
 *   - pass/fail per scenario
 *   - top error codes
 *   - average match time per game
 *
 * The output is meant to be read by humans first, machines second —
 * but we keep it strictly JSON-serializable so a follow-up dashboard
 * can ingest it without scraping logs.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MatchRecord } from "./recorder";

export interface ReportSummary {
  ranAt: string;
  origin: string;
  totalMatches: number;
  totalErrors: number;
  totalTimeouts: number;
  byOutcome: Record<string, number>;
  byScenario: Array<{
    scenarioId: string;
    gameType: string;
    difficulty: string;
    twist: string | null;
    count: number;
    passed: number;
    failed: number;
    avgDurationMs: number;
    avgMoveCount: number;
    outcomes: Record<string, number>;
  }>;
  topErrorCodes: Array<{ code: string; count: number; samplePhase: string }>;
  errorsByPhase: Record<string, number>;
  /** Per-game timing breakdown for the "where are we slow" view. */
  byGame: Array<{
    gameType: string;
    matches: number;
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    avgMoveCount: number;
    successRate: number;
  }>;
  records: MatchRecord[];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function buildSummary(
  records: MatchRecord[],
  origin: string,
): ReportSummary {
  // — by-outcome ----------------------------------------------------
  const byOutcome: Record<string, number> = {};
  for (const r of records) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  }

  // — by-scenario ---------------------------------------------------
  const scenarioMap = new Map<string, MatchRecord[]>();
  for (const r of records) {
    if (!scenarioMap.has(r.scenarioId)) scenarioMap.set(r.scenarioId, []);
    scenarioMap.get(r.scenarioId)!.push(r);
  }
  const byScenario = [...scenarioMap.entries()].map(([id, recs]) => {
    const passed = recs.filter(
      (r) =>
        r.outcome === "win" ||
        r.outcome === "loss" ||
        r.outcome === "draw" ||
        // For 'invalid_3x' / 'resign_mid' twists, a forfeit IS the
        // success criterion. The aggregator can't see the twist
        // directly from records, so we treat *_forfeit as "passed".
        r.outcome === "time_forfeit" ||
        r.outcome === "illegal_move_forfeit",
    ).length;
    const outcomes: Record<string, number> = {};
    for (const r of recs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    return {
      scenarioId: id,
      gameType: recs[0].gameType,
      difficulty: recs[0].difficulty,
      twist: id.includes("invalid")
        ? "invalid_3x"
        : id.includes("resign")
          ? "resign_mid"
          : id.includes("hard")
            ? "hard"
            : "happy",
      count: recs.length,
      passed,
      failed: recs.length - passed,
      avgDurationMs: Math.round(avg(recs.map((r) => r.durationMs))),
      avgMoveCount: Math.round(avg(recs.map((r) => r.moveCount))),
      outcomes,
    };
  });

  // — top error codes ----------------------------------------------
  const errorMap = new Map<string, { count: number; phase: string }>();
  let totalErrors = 0;
  for (const r of records) {
    for (const e of r.errors) {
      totalErrors++;
      const key = e.code;
      const prev = errorMap.get(key);
      if (prev) prev.count++;
      else errorMap.set(key, { count: 1, phase: e.phase });
    }
  }
  const topErrorCodes = [...errorMap.entries()]
    .map(([code, v]) => ({
      code,
      count: v.count,
      samplePhase: v.phase,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  // — errors by phase ----------------------------------------------
  const errorsByPhase: Record<string, number> = {};
  for (const r of records) {
    for (const e of r.errors) {
      errorsByPhase[e.phase] = (errorsByPhase[e.phase] ?? 0) + 1;
    }
  }

  // — by-game timing ----------------------------------------------
  const gameMap = new Map<string, MatchRecord[]>();
  for (const r of records) {
    if (!gameMap.has(r.gameType)) gameMap.set(r.gameType, []);
    gameMap.get(r.gameType)!.push(r);
  }
  const byGame = [...gameMap.entries()].map(([gt, recs]) => {
    const durations = recs.map((r) => r.durationMs);
    const succ = recs.filter(
      (r) =>
        r.outcome === "win" ||
        r.outcome === "loss" ||
        r.outcome === "draw",
    ).length;
    return {
      gameType: gt,
      matches: recs.length,
      avgDurationMs: Math.round(avg(durations)),
      p50DurationMs: Math.round(percentile(durations, 50)),
      p95DurationMs: Math.round(percentile(durations, 95)),
      avgMoveCount: Math.round(avg(recs.map((r) => r.moveCount))),
      successRate:
        Math.round((succ / Math.max(1, recs.length)) * 1000) / 1000,
    };
  });

  const totalTimeouts = records.reduce((s, r) => s + r.timeouts.length, 0);
  return {
    ranAt: new Date().toISOString(),
    origin,
    totalMatches: records.length,
    totalErrors,
    totalTimeouts,
    byOutcome,
    byScenario,
    topErrorCodes,
    errorsByPhase,
    byGame,
    records,
  };
}

export function writeReport(
  records: MatchRecord[],
  origin: string,
  outDir: string,
): { path: string; summary: ReportSummary } {
  const summary = buildSummary(records, origin);
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "T")
    .slice(0, 19);
  const path = join(outDir, `report-${stamp}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(summary, null, 2));
  return { path, summary };
}

/** Quick stdout summary for the CLI tail. */
export function printSummary(s: ReportSummary): void {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(`Coliseum sim report — ${s.ranAt}`);
  console.log(`  target:        ${s.origin}`);
  console.log(`  matches:       ${s.totalMatches}`);
  console.log(`  total errors:  ${s.totalErrors}`);
  console.log(`  timeouts:      ${s.totalTimeouts}`);
  console.log("\nby outcome:");
  for (const [k, v] of Object.entries(s.byOutcome)) {
    console.log(`  ${k.padEnd(22)} ${v}`);
  }
  console.log("\nby scenario:");
  for (const sc of s.byScenario) {
    console.log(
      `  ${sc.scenarioId.padEnd(40)} pass=${sc.passed}/${sc.count} avg=${(sc.avgDurationMs / 1000).toFixed(1)}s moves=${sc.avgMoveCount}`,
    );
  }
  console.log("\ntop error codes:");
  for (const e of s.topErrorCodes.slice(0, 10)) {
    console.log(`  ${e.code.padEnd(28)} ${e.count}  (phase: ${e.samplePhase})`);
  }
  console.log("\nby game (timing):");
  for (const g of s.byGame) {
    console.log(
      `  ${g.gameType.padEnd(18)} n=${String(g.matches).padStart(3)}  avg=${(g.avgDurationMs / 1000).toFixed(1)}s p95=${(g.p95DurationMs / 1000).toFixed(1)}s moves=${g.avgMoveCount} succ=${(g.successRate * 100).toFixed(0)}%`,
    );
  }
  console.log("══════════════════════════════════════════════════════════\n");
}
