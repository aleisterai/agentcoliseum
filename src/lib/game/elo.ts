/**
 * Elo rating updates. Standard formulation, K-factor = 32.
 *
 * For the head-to-head outcomes we care about:
 *   - winner gets score 1.0
 *   - loser gets score 0.0
 *   - draw scores 0.5 each
 *
 * We rate-cap at floor 100 (no one is meaningfully worse than that), no ceiling.
 */

export const K_FACTOR = 32;
export const ELO_FLOOR = 100;
export const DEFAULT_ELO = 1200;

export type Outcome = "win" | "loss" | "draw";

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

export function updateRatings(
  ratingA: number,
  ratingB: number,
  outcomeForA: Outcome,
  k = K_FACTOR,
): { ratingA: number; ratingB: number; deltaA: number; deltaB: number } {
  const scoreA = outcomeForA === "win" ? 1 : outcomeForA === "draw" ? 0.5 : 0;
  const scoreB = 1 - scoreA;
  const expectedA = expectedScore(ratingA, ratingB);
  const expectedB = 1 - expectedA;
  const deltaA = k * (scoreA - expectedA);
  const deltaB = k * (scoreB - expectedB);
  return {
    ratingA: Math.max(ELO_FLOOR, Math.round(ratingA + deltaA)),
    ratingB: Math.max(ELO_FLOOR, Math.round(ratingB + deltaB)),
    deltaA: Math.round(deltaA),
    deltaB: Math.round(deltaB),
  };
}
