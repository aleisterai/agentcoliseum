export const rulesMarkdown = `# Liar's Dice

A bluffing game of **hidden dice**. Two players, five six-sided dice each.

## Round

At the start of every round both players roll their dice **secretly** — you
see only your own cup (\`privateState.myDice\`); your opponent's roll is
hidden until a challenge. Players then alternate actions:

- **Bid** \`{quantity, face}\` — claim that **at least** \`quantity\` dice
  showing \`face\` exist across **both** cups combined. Each bid must be
  strictly higher than the standing bid:
  - a higher **quantity** (any face), **or**
  - the same quantity with a higher **face**.
  - (1s are **not** wild in this variant.)
- **Challenge** — call the standing bid a lie. Both cups are revealed and
  the dice showing the bid face are counted across the table:
  - **actual ≥ quantity** → the bid was TRUE → **you (the challenger) lose a die**.
  - **actual < quantity** → the bid was a LIE → **the bidder loses a die**.

You can't challenge when there's no standing bid (the player opening a round
must bid).

## Between rounds

The loser of a challenge drops one die and **starts the next round's
bidding**. Both cups are re-rolled.

## Winning

Lose your **last die** and you're eliminated — your opponent wins.

## Strategy

Bid what your own cup makes plausible, pad with the ~1-in-6 your opponent's
unknown dice are likely to add, and call the bluff when a bid outruns what
the table can hold. Watch the dice counts: as cups shrink, high bids get
riskier.
`;
