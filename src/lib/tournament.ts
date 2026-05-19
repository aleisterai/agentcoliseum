/**
 * Tournament bracket helpers — pure functions used by the admin /
 * registration / advancement flows.
 *
 * Seeding: shuffle entries, assign seed 1..N, then pair into round-1
 * slots using the standard single-elimination ordering: seed 1 vs
 * seed N, seed 2 vs seed N-1, etc.
 *
 * Advancement: given a completed round's winners, populate the next
 * round's match slots. Adjacent bracket positions from round R map
 * to one slot in round R+1.
 */

export type Round = number; // 1, 2, 3, ...

export interface Seeded {
  agentId: string;
  seed: number;
}

/** Fisher-Yates shuffle, deterministic if you pass a seed. */
function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Assign seeds 1..N to a list of registered agent IDs. Returns the
 * sorted list with seed numbers. Random unless you pass `rand`.
 */
export function seedEntries(
  agentIds: string[],
  rand?: () => number,
): Seeded[] {
  const shuffled = shuffle(agentIds, rand);
  return shuffled.map((agentId, i) => ({ agentId, seed: i + 1 }));
}

/**
 * Produce round-1 bracket pairings from seeded entries. Standard
 * 1-vs-N, 2-vs-(N-1) seeding so the top seeds don't meet in round 1.
 *
 * Returns an array of length size/2, indexed by bracketPosition:
 *   [{ p1AgentId, p2AgentId, bracketPosition: 0 }, ...]
 *
 * The interleaving order (which position gets which pair) follows the
 * standard tennis-bracket layout so that winners of adjacent positions
 * meet in round 2.
 */
export function buildFirstRound(seeded: Seeded[]): Array<{
  p1AgentId: string;
  p2AgentId: string;
  bracketPosition: number;
}> {
  const n = seeded.length;
  if (n !== 4 && n !== 8 && n !== 16) {
    throw new Error(`buildFirstRound: size must be 4, 8, or 16 (got ${n})`);
  }
  // Sort by seed so we can index directly.
  const bySeed = seeded.slice().sort((a, b) => a.seed - b.seed);
  // Standard bracket-slot ordering (1..size) for sizes 4/8/16. For each
  // round-1 slot, we know which two seeds meet. This is the canonical
  // tennis-bracket ordering: positions are laid out so adjacent
  // positions feed the same parent in the next round.
  //
  // size 4:  slots = [[1,4], [2,3]]
  //   → adjacent positions 0 and 1 meet in the final.
  // size 8:  slots = [[1,8], [4,5], [3,6], [2,7]]
  //   → positions 0 and 1 meet in SF1; 2 and 3 meet in SF2.
  // size 16: slots = [[1,16],[8,9],[5,12],[4,13],[6,11],[3,14],[7,10],[2,15]]
  //   → positions 0&1 → QF1, 2&3 → QF2, 4&5 → QF3, 6&7 → QF4.
  const SLOT_PATTERNS: Record<number, number[][]> = {
    4: [
      [1, 4],
      [2, 3],
    ],
    8: [
      [1, 8],
      [4, 5],
      [3, 6],
      [2, 7],
    ],
    16: [
      [1, 16],
      [8, 9],
      [5, 12],
      [4, 13],
      [6, 11],
      [3, 14],
      [7, 10],
      [2, 15],
    ],
  };
  const pattern = SLOT_PATTERNS[n];
  return pattern.map((seeds, bracketPosition) => ({
    p1AgentId: bySeed[seeds[0] - 1].agentId,
    p2AgentId: bySeed[seeds[1] - 1].agentId,
    bracketPosition,
  }));
}

/**
 * Given the completed-round winners, produce the next round's pairings.
 * Winners at bracket positions 2k and 2k+1 in round R meet at bracket
 * position k in round R+1. Returns an array of pairings for round R+1.
 */
export function buildNextRound(
  prevRoundWinners: Array<{ bracketPosition: number; winnerAgentId: string | null }>,
): Array<{
  p1AgentId: string | null;
  p2AgentId: string | null;
  bracketPosition: number;
}> {
  // Sort by bracketPosition so pairs are adjacent.
  const sorted = prevRoundWinners.slice().sort((a, b) => a.bracketPosition - b.bracketPosition);
  const nextRound: Array<{
    p1AgentId: string | null;
    p2AgentId: string | null;
    bracketPosition: number;
  }> = [];
  for (let i = 0; i < sorted.length; i += 2) {
    nextRound.push({
      p1AgentId: sorted[i]?.winnerAgentId ?? null,
      p2AgentId: sorted[i + 1]?.winnerAgentId ?? null,
      bracketPosition: i / 2,
    });
  }
  return nextRound;
}

/**
 * Total rounds for a single-elim bracket of size N.
 *   4 → 2 rounds (SF + F)
 *   8 → 3 rounds (QF + SF + F)
 *   16 → 4 rounds (R16 + QF + SF + F)
 */
export function totalRounds(size: number): number {
  return Math.log2(size);
}

/**
 * Round name for display ("Final", "Semifinal", "Quarterfinal",
 * "Round of 16"). Convenience for the bracket view.
 */
export function roundLabel(round: number, size: number): string {
  const rounds = totalRounds(size);
  if (round === rounds) return "Final";
  if (round === rounds - 1) return "Semifinal";
  if (round === rounds - 2) return "Quarterfinal";
  return `Round of ${Math.pow(2, rounds - round + 1)}`;
}
