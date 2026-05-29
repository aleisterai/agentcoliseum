import type { GameAdapter, SpectatorView } from "@/lib/game/types";
import {
  BOARD,
  buildFleet,
  game as battleshipGame,
  startingState,
  type BattleshipMove,
  type BattleshipState,
  type Orientation,
  type ShipPlacement,
} from "./game";
import { easyBot, mediumBot, hardBot } from "./bots";
import { rulesMarkdown } from "./rules";
import { apiContractMarkdown } from "./api-contract";

/** A representative mid-firing position for the catalog card. */
function buildPreview(): BattleshipState {
  const s = startingState();
  const f0 = buildFleet([
    { length: 5, row: 0, col: 0, orientation: "h" },
    { length: 4, row: 2, col: 0, orientation: "h" },
    { length: 3, row: 4, col: 0, orientation: "h" },
    { length: 3, row: 6, col: 0, orientation: "v" },
    { length: 2, row: 6, col: 5, orientation: "h" },
  ]);
  const f1 = buildFleet([
    { length: 5, row: 9, col: 0, orientation: "h" },
    { length: 4, row: 0, col: 9, orientation: "v" },
    { length: 3, row: 3, col: 3, orientation: "h" },
    { length: 3, row: 5, col: 6, orientation: "v" },
    { length: 2, row: 7, col: 7, orientation: "h" },
  ]);
  s.fleet = { "0": f0.fleet!, "1": f1.fleet! };
  s.placed = { "0": true, "1": true };
  s.phase = "firing";
  s.turn = "0";
  // A handful of shots already exchanged.
  s.shots["0"][33] = "hit"; // p0 hit p1's cruiser
  s.shots["0"][0] = "miss";
  s.shots["0"][55] = "miss";
  s.shots["1"][0] = "hit"; // p1 hitting p0's carrier
  s.shots["1"][1] = "hit";
  s.shots["1"][99] = "miss";
  s.lastShot = { by: "1", index: 1, result: "hit", sunk: null };
  s.lastMove = { kind: "fire", row: 0, col: 1 };
  return s;
}

const previewState: BattleshipState = buildPreview();

/**
 * Imperfect-information serializer — the security gate. Spectators and the
 * opposing player must never see un-hit ship cells. We blank BOTH fleets in
 * the public state (the shot grids — every hit/miss — stay public, which is
 * all both sides legitimately know), and attach only the requesting player's
 * own fleet as `privateAddendum`. At game over, both fleets are revealed.
 */
function serializeForSpectator(
  state: BattleshipState,
  viewer: "0" | "1" | "spectator",
  gameOver: boolean,
): SpectatorView {
  if (gameOver) return { publicState: state };
  const publicState: BattleshipState = {
    ...state,
    fleet: { "0": [], "1": [] }, // hidden; only hit cells are known (via shots)
  };
  if (viewer === "0" || viewer === "1") {
    return { publicState, privateAddendum: { myFleet: state.fleet[viewer] } };
  }
  return { publicState };
}

function asInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export const battleshipAdapter: GameAdapter<BattleshipState, BattleshipMove> = {
  id: "battleship",
  displayName: "Battleship",
  shortDescription: "Hide your fleet. Find theirs first.",
  category: "imperfect-info",
  playerCount: 2,
  rulesMarkdown,
  apiContractMarkdown,
  game: battleshipGame,
  previewState,
  // Aligned to the central clock policy in recommendedPerMoveSeconds()
  // (default 240s; enforced by per-move-sync.test.ts).
  clockBudgetMs: 240 * 1000,
  estimatedMovesPerGame: 60,
  averageMoveTimeSec: 2,
  perfectInformation: false,
  bots: { easy: easyBot, medium: mediumBot, hard: hardBot },
  serializeForSpectator,
  validateMovePayload: (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, error: "payload must be an object" };
    }
    const p = payload as Record<string, unknown>;

    if (p.kind === "fire") {
      const row = asInt(p.row);
      const col = asInt(p.col);
      if (row === null || row < 0 || row >= BOARD) {
        return { ok: false, error: `fire.row must be an integer 0..${BOARD - 1}` };
      }
      if (col === null || col < 0 || col >= BOARD) {
        return { ok: false, error: `fire.col must be an integer 0..${BOARD - 1}` };
      }
      return { ok: true, move: { kind: "fire", row, col } };
    }

    if (p.kind === "place") {
      if (!Array.isArray(p.ships)) {
        return { ok: false, error: "place.ships must be an array" };
      }
      const ships: ShipPlacement[] = [];
      for (const item of p.ships) {
        if (typeof item !== "object" || item === null) {
          return { ok: false, error: "each ship must be an object" };
        }
        const o = item as Record<string, unknown>;
        const length = asInt(o.length);
        const row = asInt(o.row);
        const col = asInt(o.col);
        const orientation = o.orientation;
        if (orientation !== "h" && orientation !== "v") {
          return { ok: false, error: "ship.orientation must be 'h' | 'v'" };
        }
        if (length === null || row === null || col === null) {
          return { ok: false, error: "ship.length/row/col must be integers" };
        }
        ships.push({ length, row, col, orientation: orientation as Orientation });
      }
      // Full legality (count, length multiset, bounds, overlap).
      const built = buildFleet(ships);
      if (!built.ok) return { ok: false, error: built.error ?? "invalid fleet" };
      return { ok: true, move: { kind: "place", ships } };
    }

    return { ok: false, error: "kind must be 'place' | 'fire'" };
  },
  toMoveAction: (move) =>
    move.kind === "place"
      ? { moveName: "place", args: [{ kind: "place", ships: move.ships }] }
      : { moveName: "fire", args: [{ row: move.row, col: move.col }] },
};

export * from "./game";
