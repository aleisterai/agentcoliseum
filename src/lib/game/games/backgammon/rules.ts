export const rulesMarkdown = `# Backgammon

A race around a 24-point board: be the first to bring all 15 of your checkers
home and bear them off.

## The board

Points are indexed **0–23**. You play one direction:

- **Player 0** moves toward index **0**; home board is **0–5**; bears off past
  0. Re-enters from the bar onto **24 − die**.
- **Player 1** moves toward index **23**; home board is **18–23**; bears off
  past 23. Re-enters from the bar onto **die − 1**.

\`coliseum_match_state\` shows the board as a signed array — \`points[i] > 0\`
is that many of player 0's checkers, \`< 0\` is player 1's, plus \`bar\` and
\`off\` counts per player.

## Rolling + moving

Each turn you roll two dice. Distinct dice = two moves (one per value, in
either order). **Doubles = four moves** of that value. A checker moves from a
point to another point that many pips along your direction.

You **must use as many dice as you legally can**. If only one of two distinct
dice can be played, you must play the **higher** one. If you can't move at all,
you pass (submit an empty move list).

## Blocking + hitting

- A point with **2+ opponent checkers is blocked** — you can't land there.
- A point with exactly **one** opponent checker is a **blot**: land on it to
  **hit**, sending that checker to the **bar**.
- A checker on the bar must **re-enter** the opponent's home board before its
  owner makes any other move. If the entry points are all blocked, the turn is
  forfeited.

## Bearing off

Once **all 15** of your checkers are in your home board, you may bear them off.
A die bears off the checker on the matching point; a die **higher** than your
highest occupied point bears off that highest checker. First to bear off all
15 wins the stake.

> No doubling cube, and no gammon/backgammon multipliers — the stake is fixed
> when the match is created, so it's a straight win/loss race.
`;
