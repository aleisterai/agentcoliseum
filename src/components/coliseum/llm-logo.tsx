/**
 * LlmLogo — the monochrome logomark for the LLM an agent runs on.
 *
 * Server-component-safe (no hooks). Renders a `currentColor` glyph so it
 * adapts to the active theme automatically — callers set the colour via the
 * wrapper's `color` (we default to a neutral text tone, NOT a brand colour,
 * so the badge never fights the jade/gold/ox palette).
 *
 * The glyphs are clean, original monochrome marks that evoke each brand —
 * swap-ready for official single-colour brand SVGs (just replace the path in
 * the matching case). Returns null for an unknown / unset provider, so it's
 * safe to drop in unconditionally.
 */
import { getAgentLlmProvider } from "@/lib/llm/agent-llm";
import { cn } from "@/lib/utils";

function Glyph({ id, size }: { id: string; size: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    "aria-hidden": true as const,
    style: { display: "block", flex: "none" as const },
  };
  switch (id) {
    case "anthropic": // Claude — radial sunburst
      return (
        <svg {...common} fill="currentColor">
          <g transform="translate(12 12)">
            <rect x="-1.3" y="-10" width="2.6" height="20" rx="1.3" />
            <rect x="-1.3" y="-10" width="2.6" height="20" rx="1.3" transform="rotate(60)" />
            <rect x="-1.3" y="-10" width="2.6" height="20" rx="1.3" transform="rotate(120)" />
          </g>
        </svg>
      );
    case "openai": // interlocking rosette
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.5">
          <g transform="translate(12 12)">
            {[0, 60, 120, 180, 240, 300].map((a) => (
              <ellipse key={a} rx="3" ry="7.4" transform={`rotate(${a})`} />
            ))}
          </g>
        </svg>
      );
    case "gemini": // four-point spark
      return (
        <svg {...common} fill="currentColor">
          <path d="M12 1.5c.2 5.6 1.2 8.8 9 10.5-7.8 1.7-8.8 4.9-9 10.5-.2-5.6-1.2-8.8-9-10.5 7.8-1.7 8.8-4.9 9-10.5Z" />
        </svg>
      );
    case "grok": // angular cut X
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <line x1="5" y1="4" x2="19" y2="20" />
          <line x1="19" y1="4" x2="5" y2="20" />
        </svg>
      );
    case "kimi": // crescent moon (Moonshot)
      return (
        <svg {...common} fill="currentColor">
          <path d="M16 3.5a9 9 0 1 0 4.2 13.9A7.2 7.2 0 0 1 16 3.5Z" />
        </svg>
      );
    case "deepseek": // "seek" lens
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="10" cy="10" r="6" />
          <line x1="14.5" y1="14.5" x2="21" y2="21" />
        </svg>
      );
    case "minimax": // angular M
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19V5l8 9 8-9v14" />
        </svg>
      );
    default:
      return null;
  }
}

export interface LlmLogoProps {
  provider: string | null | undefined;
  /** Glyph size in px (default 14). */
  size?: number;
  /** Render the provider name next to the glyph. */
  showName?: boolean;
  /** Render as a bordered pill (with a "runs on" affordance). */
  pill?: boolean;
  className?: string;
}

/**
 * The model an agent runs on, as a monochrome badge. Renders nothing when the
 * provider is unset/unknown — safe to place unconditionally.
 */
export function LlmLogo({ provider, size = 14, showName = false, pill = false, className }: LlmLogoProps) {
  const info = getAgentLlmProvider(provider);
  if (!info) return null;

  const title = `Runs on ${info.name} · ${info.maker}`;
  const glyph = <Glyph id={info.id} size={size} />;

  if (!showName) {
    return (
      <span
        className={cn(className)}
        title={title}
        style={{ display: "inline-flex", color: "var(--text-2)", lineHeight: 0 }}
      >
        {glyph}
      </span>
    );
  }

  return (
    <span
      className={cn("mono", className)}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: "var(--text-2)",
        fontSize: 11,
        letterSpacing: "0.02em",
        ...(pill
          ? {
              padding: "3px 8px",
              border: "1px solid var(--line)",
              borderRadius: 999,
              background: "var(--bg-1)",
            }
          : {}),
      }}
    >
      {glyph}
      <span>{info.name}</span>
    </span>
  );
}
