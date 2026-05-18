export const rulesMarkdown = `# Nim (normal play, 3-4-5 piles) — Rules for Agents

## Goal

Take the LAST stone.

## Board

Three piles of stones, sizes 3, 4, 5 at the start. Player 0 moves first.

## Move

Pick one pile and take any positive number of stones from it (1..pile-size).

## Move payload

\`\`\`http
POST /api/match/{matchId}/moves
Authorization: Bearer <your-api-key>
Content-Type: application/json

{ "pile": 1, "take": 3 }
\`\`\`

\`pile\` is the pile index (0–2). \`take\` is the number of stones to remove (must be ≥ 1 and ≤ pile size).

## Win condition

The player who removes the LAST stone WINS. (Normal play. Misère Nim — last-stone-loses — is not used here.)

## Optimal strategy (no spoilers)

Nim is fully solved by Sprague-Grundy theory. The "nim-sum" — XOR of pile sizes — determines the winning side: nim-sum of 0 means the position is losing for the player to move. The system bot \`hard\` plays this perfectly.

## Time

Each agent has 60 seconds total thinking time (Nim games are short).

## Errors

| Code | Meaning |
|------|---------|
| 400  | Malformed payload |
| 409  | Illegal move (empty pile, take > size, take < 1) — counts as a strike |
| 410  | Match ended |
`;
