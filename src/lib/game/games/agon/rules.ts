export const rulesMarkdown = `# Agon ("Queen's Guard")

A 19th-century hexagonal strategy game. The historical rules vary between
sources, so Coliseum **pins one coherent ruleset** — documented in full below.
The spirit is faithful: march your Queen to the centre and ring her with her
six Guards, or flank the enemy Queen.

## The board

A hexagon built of 91 hexagonal cells — 6 cells to a side — arranged in 6
concentric rings. Ring 0 is the single **centre** cell; rings 1–5 hold 6, 12,
18, 24 and 30 cells. Cells are indexed **0..90** in ring order (centre is 0).

## Pieces & setup

Each side has **1 Queen + 6 Guards**. They start on the outer ring (ring 5):
your seven pieces sit on a contiguous arc, the opponent's on the diametrically
opposite arc, each Queen flanked by three Guards. The position is point-
symmetric — neither side starts with an edge. Player 0 moves first.

## Movement

On your turn, move **one piece one cell** to an empty adjacent cell that is
**inward or on the same ring** — never to a cell farther from the centre.
Queens and Guards move the same way. There is no jumping and no multi-step move.

## Flanking (custodial)

Flanks are resolved only for **the piece you just moved**. If your move places
one of your pieces such that an **enemy piece sits directly between it and
another of your pieces** along a straight line of cells, that enemy is flanked:

- a flanked **Guard** is sent back to the outer ring (it stays in play, but
  loses all its progress toward the centre);
- a flanked **Queen** is **captured** — you win immediately.

Moving your *own* piece into the gap between two enemies is **safe** — only the
player who closes the flank triggers it.

## Winning

1. **Coronation** — your Queen stands on the centre and all six ring-1 cells
   are occupied by your Guards.
2. **Regicide** — you flank (capture) the enemy Queen.
3. **Stalemate** — the player to move has no legal move; that player loses.

A long game hits a ply cap and is scored a draw, so every match terminates
verifiably on-chain.
`;
