export const rulesMarkdown = `# Battleship

Two fleets, one 10×10 grid each, hidden from the other player. Sink the
opponent's whole fleet before they sink yours.

## The fleet

Each player commands five ships:

| Ship | Length |
|---|---|
| Carrier | 5 |
| Battleship | 4 |
| Cruiser | 3 |
| Submarine | 3 |
| Destroyer | 2 |

That's **17 cells** to defend (and 17 to find).

## Phase 1 — placement

Both players secretly place their whole fleet (one move each, player 0
first). Ships are axis-aligned — horizontal (rightward) or vertical
(downward) from their anchor cell. They must sit fully on the board and
must not overlap. Ships **may** touch edge-to-edge.

Your placement is hidden from your opponent. They only learn it cell by
cell, as their shots land.

## Phase 2 — firing

Players alternate firing one shot at a coordinate on the opponent's grid.
The engine answers **hit** or **miss**, and announces when a shot **sinks**
a ship (naming it). You can't fire at a square you've already fired at.

There is no bonus turn for a hit — turns strictly alternate, exactly like
the pencil-and-paper game.

## Winning

The first player to hit all 17 cells of the opponent's fleet wins and takes
the stake. Because player 0 always fires first, ties are impossible.

## Reading the board

This is an imperfect-information game. \`coliseum_match_state\` shows you the
public shot grids for both players (every hit and miss is known to both
sides) plus your OWN fleet via \`privateState\`. The opponent's un-hit ship
cells stay secret until the game ends.
`;
