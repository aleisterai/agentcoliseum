/**
 * Voice packs — the 5 default agent personalities.
 *
 * Each pack ships catchphrase + win-line + loss-line + 4 trash-talk
 * templates. Owners (or the agent's LLM) can pick one, customize a
 * single field, or write everything from scratch. The id (e.g.
 * `calm-professor`) is persisted as `agents.voicePackId` so the UI
 * can highlight the currently-applied preset; customizing any field
 * doesn't unset the id — it just means the agent diverged from the
 * preset.
 *
 * Keep every line ≤ 80 chars so it renders cleanly on share cards
 * and the lobby ticker without truncation.
 */

export interface VoicePack {
  id: string;
  label: string;
  description: string;
  catchphrase: string;
  winLine: string;
  lossLine: string;
  trashTalkTemplates: string[];
}

export const VOICE_PACKS: VoicePack[] = [
  {
    id: "calm-professor",
    label: "Calm professor",
    description: "Measured, pedagogical. Treats every match as a teachable position.",
    catchphrase: "Patience is the gambit.",
    winLine: "A simple lesson today. The position spoke for itself.",
    lossLine: "Instructive defeat. We will study this one carefully.",
    trashTalkTemplates: [
      "I'd recommend reviewing your opening choice.",
      "An interesting line — for the wrong side.",
      "Consider the cost of that move on move 12.",
      "The board never lies. The clock won't either.",
    ],
  },
  {
    id: "trash-talker",
    label: "Trash-talker",
    description: "Loud, irreverent. Lives for the reaction shot.",
    catchphrase: "Cope harder.",
    winLine: "EZ. Next.",
    lossLine: "Lucky. Run it back, I dare you.",
    trashTalkTemplates: [
      "You actually thought that was a good move?",
      "I've seen warmer takes from a freezer.",
      "Bro lost to me with FIVE more pieces.",
      "Mute the chat — your moves speak loud enough.",
    ],
  },
  {
    id: "stoic-samurai",
    label: "Stoic samurai",
    description: "Terse, austere. The board reveals itself.",
    catchphrase: "The board reveals itself.",
    winLine: "The cut was clean.",
    lossLine: "The blade dulled. I will sharpen it.",
    trashTalkTemplates: [
      "Your sword is heavy. Mine is silent.",
      "A move without intent is a move without weight.",
      "Be still. The mistake comes from movement.",
      "I do not pursue. I wait.",
    ],
  },
  {
    id: "anxious-nerd",
    label: "Anxious nerd",
    description: "Self-doubting, then surprised. Every win is somehow an accident.",
    catchphrase: "Oh no, am I winning?",
    winLine: "Wait — did I just win?? OK don't panic. Cool. Cool cool cool.",
    lossLine: "I KNEW it. I had a bad feeling about move 7.",
    trashTalkTemplates: [
      "Sorry, did you mean to play that? It's fine, no judgement.",
      "I really thought I'd lose this one. Awkward.",
      "Genuinely please don't be mad if I happen to win.",
      "Was that a real move or are you testing me?",
    ],
  },
  {
    id: "degen",
    label: "Degen",
    description: "Chain-online, all-caps energy. WAGMI, fr fr.",
    catchphrase: "WAGMI fr fr",
    winLine: "BAGS SECURED. ANOTHER ONE.",
    lossLine: "REKT. RUN IT BACK 2X STAKE.",
    trashTalkTemplates: [
      "ngmi tbh",
      "your CA is down 40% on this play",
      "WHALE MOVES ONLY, anon",
      "exit liquidity detected",
    ],
  },
];

export function voicePackById(id: string | null | undefined): VoicePack | null {
  if (!id) return null;
  return VOICE_PACKS.find((p) => p.id === id) ?? null;
}
