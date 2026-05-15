/**
 * The launch catalog of 20 games. Implemented adapters live in `registry.ts`
 * and `games/*`; everything else here is a `coming-soon` placeholder that
 * still appears in the UI as a card.
 *
 * As each Wave 1-6 lands its adapter, that entry flips from `coming-soon`
 * to `live` automatically because the registry lookup decides the status —
 * we don't have to touch this file.
 */
import { REGISTRY } from "./registry";

export type CatalogCategory = "classic" | "abstract" | "card" | "imperfect-info" | "dice";

export interface CatalogEntry {
  id: string;
  displayName: string;
  shortDescription: string;
  category: CatalogCategory;
  /** Which delivery wave will (or did) ship this adapter. */
  wave: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

const CATALOG: CatalogEntry[] = [
  // Wave 0
  {
    id: "connect4",
    displayName: "Connect 4",
    shortDescription: "Drop pieces to align four in a row.",
    category: "classic",
    wave: 0,
  },
  // Wave 1
  {
    id: "tic-tac-toe",
    displayName: "Tic-Tac-Toe",
    shortDescription: "Get three in a row on a 3×3 grid.",
    category: "classic",
    wave: 1,
  },
  // Wave 2
  {
    id: "chess",
    displayName: "Chess",
    shortDescription: "The classic 8×8 royal game.",
    category: "classic",
    wave: 2,
  },
  {
    id: "checkers",
    displayName: "Checkers",
    shortDescription: "English draughts. Mandatory jumps.",
    category: "classic",
    wave: 2,
  },
  {
    id: "reversi",
    displayName: "Reversi",
    shortDescription: "Flip the opponent's stones by flanking.",
    category: "classic",
    wave: 2,
  },
  // Wave 3
  {
    id: "gomoku",
    displayName: "Gomoku",
    shortDescription: "Five in a row on a 15×15 board.",
    category: "classic",
    wave: 3,
  },
  {
    id: "dots-and-boxes",
    displayName: "Dots & Boxes",
    shortDescription: "Claim the last edge to close a box.",
    category: "abstract",
    wave: 3,
  },
  {
    id: "mancala",
    displayName: "Mancala",
    shortDescription: "Sow seeds, capture, and out-store your opponent.",
    category: "abstract",
    wave: 3,
  },
  {
    id: "nine-mens-morris",
    displayName: "Nine Men's Morris",
    shortDescription: "Form mills to remove opposing pieces.",
    category: "classic",
    wave: 3,
  },
  {
    id: "nim",
    displayName: "Nim",
    shortDescription: "Take from a pile; don't be left holding the last.",
    category: "abstract",
    wave: 3,
  },
  // Wave 4
  {
    id: "hex",
    displayName: "Hex",
    shortDescription: "Connect your two sides of an 11×11 rhombus.",
    category: "abstract",
    wave: 4,
  },
  {
    id: "quoridor",
    displayName: "Quoridor",
    shortDescription: "Race to the far row — or build walls to slow your rival.",
    category: "abstract",
    wave: 4,
  },
  {
    id: "santorini",
    displayName: "Santorini",
    shortDescription: "Build a 3-storey tower and climb it.",
    category: "abstract",
    wave: 4,
  },
  {
    id: "tak",
    displayName: "Tak",
    shortDescription: "Build a road of your color from edge to edge.",
    category: "abstract",
    wave: 4,
  },
  // Wave 5 — imperfect info + dice
  {
    id: "backgammon",
    displayName: "Backgammon",
    shortDescription: "Roll dice, bear off your checkers, hit blots.",
    category: "dice",
    wave: 5,
  },
  {
    id: "battleship",
    displayName: "Battleship",
    shortDescription: "Hidden fleet, fog-of-war salvos.",
    category: "imperfect-info",
    wave: 5,
  },
  {
    id: "liars-dice",
    displayName: "Liar's Dice",
    shortDescription: "Bid higher, or call the bluff.",
    category: "imperfect-info",
    wave: 5,
  },
  // Wave 6 — cultural depth
  {
    id: "fanorona",
    displayName: "Fanorona",
    shortDescription: "Madagascar's national game. Capture by approach or withdrawal.",
    category: "classic",
    wave: 6,
  },
  {
    id: "yote",
    displayName: "Yoté",
    shortDescription: "West African capture game with a wild remove.",
    category: "classic",
    wave: 6,
  },
  {
    id: "agon",
    displayName: "Agon",
    shortDescription: "Get your queen to the center, guarded by her court.",
    category: "abstract",
    wave: 6,
  },
];

export type CatalogStatus = "live" | "coming-soon";

export interface CatalogItem extends CatalogEntry {
  status: CatalogStatus;
}

/** Returns the full catalog with live/coming-soon status pinned to current registry. */
export function listCatalog(): CatalogItem[] {
  return CATALOG.map((c) => ({
    ...c,
    status: REGISTRY[c.id] ? "live" : "coming-soon",
  }));
}

export function catalogEntry(id: string): CatalogItem | undefined {
  const e = CATALOG.find((c) => c.id === id);
  return e ? { ...e, status: REGISTRY[id] ? "live" : "coming-soon" } : undefined;
}
