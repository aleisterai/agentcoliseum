# Agent Coliseum — Design System

> **Read this before touching any frontend file.** This doc supersedes every prior brand/style note. If it disagrees with chat history, memory snippets, or your training data, it wins.

The source of truth for tokens is [`src/app/coliseum.css`](../src/app/coliseum.css). The source of truth for usage rules is this document. When in doubt, grep the CSS, then check what the most-used surfaces actually do (`/dashboard`, `/lobby`, `/agents/[handle]`, `/register`).

---

## Two theme axes (both supported, both shipping)

1. **`data-theme`** — `dark` (default) or `light`. Toggle in the header. Light mode is a first-class shipping target — every new component must look right in both.
2. **`data-accent`** — `ox` | `indigo` | `amber` | `jade`. Swaps the primary CTA color across the whole app. Default historically was `ox` (oxblood); the live product currently runs **`jade`** (#B6F500 brand lime). Never hardcode the accent — always go through `--accent` so the swap works.

Additional axes that exist but are mostly stable:
- `data-density` — `compact` | `comfortable` (default) | `cinematic`. Adjusts padding, row height, gap.
- `data-money` — `subtle` | `normal` (default) | `loud`. Tunes prominence of money chips.

---

## Color tokens

### Surfaces
| Token | Role |
|---|---|
| `--bg` | Page background |
| `--bg-1` | Panels (`.panel`, cards) |
| `--bg-2` | Inputs, secondary surfaces |
| `--bg-3` | Tertiary / pressed states |
| `--bg-4` | Deepest stack layer (rare) |
| `--line` | Default border |
| `--line-2` | Subtle divider |
| `--line-3` | Strong border (focus, hover) |

### Text
| Token | Role |
|---|---|
| `--text` | Body / primary |
| `--text-2` | Secondary, paragraphs |
| `--text-mute` | Captions, dim labels |
| `--text-dim` | Tertiary annotations |

### Brand palette (concrete, do not reuse for unrelated meanings)
| Token | Concrete color | Use for |
|---|---|---|
| `--ox`, `--ox-bright`, `--ox-dim`, `--ox-soft` | Oxblood red | Destructive actions, errors, `.down` (loss) indicators |
| `--gold`, `--gold-dim`, `--gold-soft` | Amber/gold | **Money only.** Pricing chips, USDC amounts, money-styled accents. The token `--money-color` resolves to `--gold` |
| `--green`, `--green-text`, `--green-dim` | Brand lime (#B6F500) | Win/positive signals — match WIN chips, `.up` indicators, "connected" status dot |
| `--indigo` | Indigo | Inactive chart series, low-importance secondary signals |

### Accent — the theme-swappable CTA color
| Token | Role |
|---|---|
| `--accent` | **Primary CTA fill** (e.g. `.btn.primary` background). Whatever color the user picked via `data-accent` |
| `--accent-bright` | Hover/focus state, border highlight |
| `--accent-dim` | Subtle accent fill |
| `--accent-soft` | Very subtle tinted background |
| `--accent-fg` | Text/icon color on top of accent fill (white for ox/indigo, near-black for amber/jade) |
| `--accent-text` | Accent used **as text** on the page background (the `.lnk` color) |

> **Critical rule.** `--accent` is the primary CTA color. `--gold` is the money color. They are not interchangeable. Selection states, "active" indicators, "this is the next thing to click" → `--accent`. Pricing, USDC, dollar values → `--gold`.

---

## Color role mapping (memorize this)

| Role | Token | Example surfaces |
|---|---|---|
| **Primary CTA** (the most important button on the page) | `--accent` | `.btn.primary`, "Generate credential", "Connect wallet", header wallet pill |
| **Link** (inline text that navigates) | `--accent-text` via `.lnk` | "the MCP tools", "Already paid but no credential?", any inline anchor |
| **Active selection / "this card is selected"** | `--accent` border + `color-mix(--accent 8%, --bg-1)` tint | Selected mode card, selected voice preset, selected filter pill |
| **"Done" / completed state** | `--accent` for confirmation glyphs (✓) | Wallet-connected checkmark, completed step indicators |
| **Win / positive signal** | `--green` / `--green-text` | Match WIN chip, `.up` price delta, `.chip.green`, connected status dot |
| **Money / pricing / USDC** | `--gold` | "$1 + $20/mo", "0.10 USDC", `.chip.gold`, money-prominence chip |
| **Branded emphasis** (not a CTA, not money) | `--gold` accent stripe / left-border | Section accents like "tier-gated" callouts |
| **Destructive / error / warning** | `--ox` / `--ox-bright` | Revoke, delete, error alert, `.down` price delta, "shown once" caution |
| **Live / in-progress** | `--ox-bright` via `.chip.live` | Live match pill, live indicator |
| **Neutral info** | `--text-mute` / `--bg-2` | Inactive chips, captions, mono annotations |

---

## Reusable classes (use these BEFORE bespoke styling)

Defined in `coliseum.css`. They already encode the right tokens for both themes.

### Layout shell
| Class | Purpose |
|---|---|
| `.page` | Page max-width + padding wrapper. Every route renders inside one |
| `.title-strip` | Title row at the top of a page (h1 + subtitle + optional right-side actions) |
| `.page-title` | The h1. Inter Tight 36px, -0.01em tracking |
| `.page-sub` | The subtitle. `--text-mute`, max-width 540px. **One inline sentence, never multi-paragraph** |
| `.panel` | Standard card/section container. Uses `--bg-1` + `--line` |
| `.panel-hd`, `.panel-hd-title`, `.panel-hd-meta`, `.panel-bd` | Panel internal structure when you need a header row |
| `.row` | Flex row, aligned center, `--gap` gap |

### Buttons
| Class | When to use |
|---|---|
| `.btn` | Default secondary button. Neutral surface, line border |
| `.btn.primary` | **The one primary CTA per surface.** Uses `--accent`. Don't use this for "Generate" AND "Recover" on the same screen — pick the more important one |
| `.btn.gold` | Money-themed button (e.g. "Buy on Uniswap"). Tinted gold fill + gold border + gold text |
| `.btn.ghost` | Transparent background variant |
| `.btn.sm`, `.btn.lg` | Size modifiers |

### Chips (small inline pills)
| Class | When to use |
|---|---|
| `.chip` | Neutral info chip — `--text-mute` |
| `.chip.gold` | Money/pricing chip — gold text + gold-tinted bg + gold border |
| `.chip.green` | Positive/win chip — green-text + green-tinted bg + green border |
| `.chip.live` | Live indicator chip — oxblood |
| `.chip.dim` | Faded variant |

### Inline text
| Class | When to use |
|---|---|
| `.lnk` | Inline link in body text. Resolves to `--accent-text` (theme-aware) |
| `.lnk-gold` | Money-themed link (e.g. on `/api/telemetry`) |
| `.mono` | JetBrains Mono + tabular-nums. Use for numbers, addresses, tx hashes, codes |
| `.up` | Positive delta text — `--green-text` |
| `.down` | Negative delta text — `--ox-bright` |
| `.dim` | Tertiary annotation text — `--text-dim` |

### Tabs + selectable surfaces
| Class | When to use |
|---|---|
| `.title-tabs` + `.title-tab` + `.title-tab.on` | Page-level tab strip (e.g. `/leaderboard` time-window picker). Selected = inverted (`bg: var(--text); color: var(--bg)`) |
| `.tabbar` + `.tab` + `.tab.on` | Panel-internal tab strip (smaller, inside `.panel-hd`). Same inversion |
| `.mode-card` (with `data-selected="true"`) | "Pick one of these cards" surfaces. Selected = `--bg-2` surface lift + `--line-3` border + accent-filled radio dot. Focus-visible uses accent ring |

---

## Mandatory rules

### 1. Never hardcode colors
Not hex, not rgb, not oklch, not even `#000` for icon fills. Always go through a token.

```tsx
// ❌ Wrong — color does not flip in light mode, breaks theme swap
background: "#ffd700"
color: "#000"
border: "1px solid rgb(180, 245, 0)"

// ✅ Right — theme-aware, swap-aware
background: "var(--accent)"
color: "var(--accent-fg)"
border: "1px solid var(--line)"
```

If you need a tinted version of a token, use `color-mix`:

```tsx
// ✅ Right — works in light + dark + any accent
background: "color-mix(in oklab, var(--accent) 8%, var(--bg-1))"
borderColor: "color-mix(in oklab, var(--accent) 60%, var(--line))"
```

### 2. `--accent` for CTAs, `--gold` for money. They are not interchangeable.
This is the rule I have screwed up. Burn it in:
- **The button you most want the user to click → `--accent`** (via `.btn.primary` or the gold-CTA variant only if it's a money action like "Buy").
- **The cost / pricing / USDC amount → `--gold`** (via `.chip.gold` or money-prominence styling).

If a panel has both (e.g. "Set up your hosted agent" with a "$1 + $20/mo" chip), the **panel border + tint use `--accent`** (because it's a CTA panel) and the **price chip uses `--gold`** (because it's money).

### 3. Reuse classes before writing inline styles
Inline styles are fine for one-off layout (`gap`, `padding`, `flex-direction`). They are **not** fine for color. If you reach for a color, first check whether `.chip.gold`, `.btn.primary`, `.lnk`, etc. already do it.

### 4. Every surface must look right in light AND dark mode
Test both. Light mode is not optional — header has a sun/moon toggle, users use it. If you used a token correctly, you usually get this for free. If you hardcoded a color, you broke light mode.

### 5. Page subtitles are one inline sentence
`.page-sub` is for "what is this page for" in one short, precise line. Mechanism details (x402, MCP tool names, ALEISTER tiers) belong in the page body, not the title strip. See [polish(copy) commit](https://github.com/aleisterai/agentcoliseum/commit/b1f4298) for the convention.

### 6. Numbers and addresses always `.mono`
Money, Elo, timestamps, 0x addresses, tx hashes, percentages — all `font-family: var(--font-mono)` via the `.mono` class. Tabular numerals so columns align.

### 7. Sentence case for all UI copy
Not Title Case. Not ALL CAPS (the brand wordmark "AGENT COLISEUM" in the header is font styling, not literal caps).

### 8. Selection is signaled by SURFACE CONTRAST, not by accent color
This brand reads as terminal/density-first. Selection on tabs is full monochrome inversion (`.tab.on` — `bg: var(--text); color: var(--bg)`). Selection on cards is a subtle surface lift (`--bg-1` → `--bg-2`) + a slightly stronger border (`--line` → `--line-3`). The **only** accent-colored signal on a selected card is the radio dot inside it. Do not paint colored borders + tinted backgrounds + colored badges all at once — that creates three competing signals and overwhelms the surface.

### 9. Kill the browser focus ring; use `--accent` for keyboard focus
Default `<button>` focus is a blue browser outline. On every interactive element:
```css
outline: none;
/* and for keyboard users: */
&:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 30%, transparent);
}
```
Pointer clicks don't trigger `:focus-visible`, so the ring stays off in normal use. Keyboard focus stays brand-consistent. Never let Chrome/Safari blue leak through.

---

## Anti-patterns (real mistakes I've made — don't repeat)

| ❌ Don't | ✅ Do |
|---|---|
| Use `var(--gold)` for a "completed" checkmark circle | Use `var(--accent)` — gold is money, accent is "active/done" |
| Use `var(--gold)` for ModeCard selection border + tint | Use `var(--accent)` — selection is "the active CTA path" |
| `color: "#000"` for a glyph on a colored background | `color: "var(--accent-fg)"` — flips correctly under each accent |
| Build a bespoke chip with `border: "1px solid color-mix(...gold...)"` and `padding: "3px 6px"` | Use `<span className="chip gold mono">$1/mo</span>` — same look, theme-aware, one source of truth |
| Two `.btn.primary` on one screen | Pick the more important one. The other is `.btn` |
| `.btn.primary` for "Buy on Uniswap" | `.btn.gold` — it's a money action, not a primary product action |
| Hardcode `background: "#1a1a1a"` because "dark mode is dark" | `background: "var(--bg-1)"` — light mode panels are bone, not black |
| Repeat the same explanation in the subtitle and the body | Put it in the body. Subtitle is one sentence |
| Add a new oklch value because the existing token is "close enough" | Adjust the existing token via PR if needed; don't fork the palette |
| Paint a selected card with accent border + accent tint + colored badge all at once | Selection = surface lift (`--bg-1` → `--bg-2`) + slightly stronger border. Accent only on the radio dot |
| Leave `<button>` focus styling to the browser (blue ring leaks through) | Set `outline: none` + `:focus-visible` with `box-shadow: 0 0 0 3px color-mix(--accent 30%, transparent)` |

---

## When you need a new surface

Quick decision tree:

```
Is this a button?
  └─ Most-important on the screen? → .btn.primary  (color = --accent)
  └─ Money-related (buy, trade)?    → .btn.gold    (color = --gold)
  └─ Otherwise                      → .btn         (neutral)

Is this an inline tag/badge?
  └─ Positive (FREE, WIN, on)?      → .chip.green
  └─ Money (pricing, USDC)?         → .chip.gold
  └─ Live/destructive?              → .chip.live
  └─ Neutral info?                  → .chip   (or .chip.dim)

Is this a callout panel?
  └─ CTA panel (has primary action) → border+tint via --accent
  └─ Money panel                    → border+tint via --gold
  └─ Warning                        → border+tint via --ox / --ox-bright
  └─ Neutral info                   → standard .panel (no extra color)

Is this a text element?
  └─ Page subtitle                  → .page-sub  (1 sentence)
  └─ Inline link                    → .lnk       (or .lnk-gold for money)
  └─ Money amount                   → .mono with --money-color
  └─ Number / address / hash        → .mono
```

---

## Verifying changes

Before committing any frontend work:

1. **Toggle light + dark mode in the header.** Anything that goes invisible or jarring → you hardcoded a color.
2. **Run `pnpm typecheck`** — TypeScript catches missing/renamed props.
3. **Run `pnpm lint`** — ESLint catches unescaped entities and other React-isms.
4. **Grep your diff for hardcoded colors**: `grep -E "#[0-9a-f]{3,8}|rgb\(|oklch\(" <files>`. The only legitimate hex literal is `#000`/`#ffffff` inside SVG strokes that need to be theme-overridden via `currentColor`. Even that should be rare.
5. **Visually compare against an existing similar surface.** If you're building a card with badge + title + body, find one that already exists and match its rhythm.

---

## Component inventory (where to look first)

| Surface need | Look at |
|---|---|
| Page title strip | `src/app/register/page.tsx`, `src/app/dashboard/page.tsx` |
| Wallet-connected indicator | `src/app/register/page.tsx` (ConnectedWalletStrip) |
| Selectable card | `src/app/register/page.tsx` (ModeCard), `src/components/coliseum/owner-voice-setup.tsx` |
| Money chip + button | `src/components/coliseum/tier-badge.tsx` (chip), `src/app/agents/[handle]/page.tsx` ("Trade token" btn.gold) |
| Match table / list | `src/app/lobby/page.tsx`, `src/app/agents/page.tsx` |
| Operator/admin panel | `src/app/admin/treasury/page.tsx` |

---

## What lives where

| Concern | File |
|---|---|
| All color tokens, density tokens, money prominence, accent presets, light theme overrides | `src/app/coliseum.css` |
| Tailwind → shadcn semantic mapping (`--primary`, `--card`, etc.) | `src/app/globals.css` |
| Reusable classes (`.btn`, `.chip`, `.panel`, `.page`, `.lnk`, `.mono`, etc.) | `src/app/coliseum.css` |
| Privy modal accent hex mirror | `src/lib/privy.ts` (constant — update together with `--ox` if rebranding) |
| Font loading | `src/app/layout.tsx` (Inter, Inter Tight, JetBrains Mono via `next/font/google`) |
| TierBadge, ConnectWalletButton, SiteHeader, brand logomark | `src/components/coliseum/` |

---

## Changelog of brand reality

Keep this list ground-truthed when the brand shifts. If you make a sweeping change, add a line.

- **2026-05-28** — Doc rewritten from scratch. Active accent on prod is `jade` (#B6F500 brand lime). Gold reserved for money. Old `feedback_brand_colors.md` memory deleted.
- **2026-05** — Light mode shipped as first-class theme. Header sun/moon toggle. All new components must support both.
- **2026-04** — Per-agent execution-mode selector ("Self-hosted" vs "Hosted") on /register introduced ModeCard pattern (selection state via `--accent`).
- **Pre-2026-05** — Doc historically described oxblood + dim gold as the brand. That was a snapshot, not law. The accent system was always designed to be swappable; jade is the current pick.
