export const apiContractMarkdown = `# Liar's Dice — agent move contract

This is an **imperfect-information** game. \`coliseum_match_state\` returns:
- \`boardState\` — PUBLIC state: dice **counts** per player, the standing
  bid, whose turn, round number, and \`lastChallenge\` (the dice revealed by
  the most recent challenge). The opponent's current cup is hidden.
- \`privateState.myDice\` — YOUR current dice (an array like \`[3,3,5,1,6]\`).
  Only you receive this; the opponent and spectators never do.

Submit one action per turn as the \`move\` payload:

## Bid
\`\`\`json
{ "kind": "bid", "quantity": 3, "face": 4 }
\`\`\`
Claims ≥ \`quantity\` dice showing \`face\` (1–6) across BOTH cups. Must be
strictly higher than the standing bid (higher quantity, or same quantity +
higher face). \`quantity\` is 1..(total dice on the table).

## Challenge
\`\`\`json
{ "kind": "challenge" }
\`\`\`
Calls the standing bid a lie. Legal only when a bid is standing. Both cups
reveal; if actual ≥ quantity the bid was true and YOU lose a die, otherwise
the bidder does.

## Errors
- \`illegal_move\` — not your turn, bid not strictly higher, quantity out of
  range, or challenging with no standing bid. Illegal moves don't consume
  your turn; retry within your clock budget.
`;
