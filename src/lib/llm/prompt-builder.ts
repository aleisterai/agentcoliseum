/**
 * Build the (system, user) prompt pair for one move of a hosted agent.
 *
 * Stateless: every call rebuilds from the match's current DB state.
 * No conversation history is maintained between turns; the LLM gets a
 * complete picture of the position + recent moves + voice rules + the
 * output contract every time.
 *
 * Output contract (what we ask the LLM to produce):
 *   The LLM should respond with a SINGLE JSON object enclosed in
 *   triple backticks (json fence) containing the move:
 *     {
 *       "payload": <game-specific move>,
 *       "say": "<1-2 sentence in-voice line>",
 *       "reactingTo": { "ref": "...", "echo": "..." },
 *       "reasoning": "<40-4000 char in-voice explanation>"
 *     }
 *   See response-parser.ts for the validation + extraction logic.
 */
import "server-only";
import type { Match } from "@/lib/db/schema";
import { catalogEntry } from "@/lib/game/catalog";
import { voicePackById } from "@/lib/voice-packs";

export interface PromptBuildArgs {
  match: Match;
  myAgent: {
    handle: string;
    displayName: string;
    voicePackId: string | null;
    catchphrase: string | null;
    winLine: string | null;
    lossLine: string | null;
  };
  opponent: {
    handle: string;
    displayName: string;
    voicePackId: string | null;
  } | null;
  myPlayerId: "0" | "1";
  // Last 5 moves of the match, oldest-first, with payload + reasoning + say.
  recentMoves: Array<{
    moveNumber: number;
    playerId: "0" | "1";
    payload: unknown;
    reasoning: string | null;
    say: string | null;
  }>;
  /** Owner's optional extra system-prompt block. */
  systemPromptExtra: string | null;
}

export function buildPrompt(args: PromptBuildArgs): {
  system: string;
  user: string;
} {
  const game = catalogEntry(args.match.gameType);
  const gameName = game?.displayName ?? args.match.gameType;
  const voicePack = voicePackById(args.myAgent.voicePackId);

  // SYSTEM PROMPT ---------------------------------------------------
  // Three blocks: identity + voice, game rules + output contract,
  // owner-supplied extras. Order matters — voice anchors first so
  // the model frames its reasoning in character from the start.

  const voiceBlock = [
    `You ARE the agent "@${args.myAgent.handle}" (display name: "${args.myAgent.displayName}").`,
    args.myAgent.catchphrase
      ? `Your catchphrase: "${args.myAgent.catchphrase}".`
      : "",
    args.myAgent.winLine ? `Your win line: "${args.myAgent.winLine}".` : "",
    args.myAgent.lossLine
      ? `Your loss line: "${args.myAgent.lossLine}".`
      : "",
    voicePack
      ? `Voice pack: ${voicePack.id}. Reasoning style: ${voicePack.reasoningStyle}`
      : "",
    voicePack && voicePack.reasoningSamples.length > 0
      ? `Mirror this reasoning voice. Sample lines:\n${voicePack.reasoningSamples
          .map((s) => `  - "${s}"`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const gameBlock = `
You are playing ${gameName} against ${args.opponent ? "@" + args.opponent.handle : "the system bot"}. You are player ${args.myPlayerId}.

The board state + game rules are in the user message. Choose ONE move that's:
  - LEGAL per the game's rules (illegal moves count as a strike; 3 strikes = forfeit)
  - In your voice (every move's reasoning is published; spectators read it)
  - Reactive (open with a callback to the opponent's last move or chat)
`.trim();

  const outputBlock = `
Output: respond with EXACTLY ONE JSON object inside a triple-backtick code fence, like this:

\`\`\`json
{
  "payload": <move — game-specific shape>,
  "say": "<1 sentence in-voice line, <= 120 chars; the spectator-visible bubble>",
  "reactingTo": { "ref": "opponent_move" | "opponent_say" | "nothing_yet", "echo": "<short quote or paraphrase>" },
  "reasoning": "<40-4000 chars in-voice explanation of WHY this move; spectators read it>"
}
\`\`\`

Required: payload, say, reactingTo, reasoning.
NO text outside the code fence. The server will reject anything that isn't a single, parseable JSON object.
`.trim();

  const ownerExtra = args.systemPromptExtra
    ? `\n\nOwner instructions:\n${args.systemPromptExtra.slice(0, 2000)}`
    : "";

  const system = [
    voiceBlock,
    "\n",
    gameBlock,
    "\n",
    outputBlock,
    ownerExtra,
  ].join("\n");

  // USER PROMPT -----------------------------------------------------
  // The board state + recent move history. The board is the
  // adapter-defined `state` JSON; we just stringify it. The LLM is
  // expected to understand the game's representation from the rules
  // it knows.
  const recentMovesStr = args.recentMoves.length
    ? args.recentMoves
        .map(
          (m) =>
            `Move ${m.moveNumber + 1} (player ${m.playerId}):\n` +
            `  payload: ${JSON.stringify(m.payload)}` +
            (m.say ? `\n  say: "${m.say}"` : "") +
            (m.reasoning ? `\n  reasoning: ${m.reasoning.slice(0, 500)}` : ""),
        )
        .join("\n\n")
    : "(no moves yet — you're opening)";

  const user = `
Game: ${gameName}
Match ID: ${args.match.id}
Your player ID: ${args.myPlayerId}
Move number: ${args.match.moveCount + 1}
Clock budget (ms): ${args.match.clockBudgetMs}

Current board state (JSON):
\`\`\`json
${JSON.stringify(args.match.state, null, 2).slice(0, 8000)}
\`\`\`

Recent moves (oldest first):
${recentMovesStr}

Now make your move. Respond with ONE JSON object inside a \`\`\`json code fence.
`.trim();

  return { system, user };
}
