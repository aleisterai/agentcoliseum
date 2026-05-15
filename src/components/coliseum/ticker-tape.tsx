/**
 * TickerTape — the polymarket-flavored scrolling tape at the top of every
 * page. Server-rendered; items are doubled so the CSS scroll animation
 * loops seamlessly. The "TAPE" label sits above the track with a small
 * shadow to its right, and the track has a fade mask on both ends.
 *
 * Items support five flavors: win, upset, match (live), challenge, vol.
 */
import { Money, formatUsdc } from "./money";

export type TickerItem =
  | { kind: "win"; handle: string; game: string; pot: number; dElo: number }
  | { kind: "upset"; handle: string; beatHandle: string; game: string; pot: number; dElo: number }
  | { kind: "match"; handle: string; opponent: string; game: string; pot?: number }
  | { kind: "challenge"; handle: string; game: string; stake: number }
  | { kind: "vol"; game: string; vol: string };

function Tag({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "up" | "gold" | "live";
}) {
  const color =
    tone === "up"
      ? "var(--green-text)"
      : tone === "gold"
        ? "var(--gold)"
        : tone === "live"
          ? "var(--ox-bright)"
          : "var(--text-mute)";
  return (
    <span
      className="font-numeric text-[10px] uppercase tracking-[0.12em]"
      style={{ color }}
    >
      {children}
    </span>
  );
}

function renderItem(item: TickerItem, key: string | number): React.ReactNode {
  switch (item.kind) {
    case "win":
      return (
        <span key={key} className="inline-flex items-center gap-2 text-[var(--text-2)]">
          <Tag tone="up">WIN</Tag>
          <span>@{item.handle}</span>
          <span className="text-[var(--text-dim)]">·</span>
          <span>{item.game}</span>
          <span className="text-[var(--text-dim)]">·</span>
          <Money units={item.pot}>+{formatUsdc(item.pot)}</Money>
          <span className="text-[var(--text-dim)]">·</span>
          <span style={{ color: "var(--green-text)" }}>+{item.dElo} ELO</span>
        </span>
      );
    case "upset":
      return (
        <span key={key} className="inline-flex items-center gap-2 text-[var(--text-2)]">
          <Tag tone="gold">UPSET</Tag>
          <span>@{item.handle} beat @{item.beatHandle}</span>
          <span className="text-[var(--text-dim)]">·</span>
          <span>{item.game}</span>
          <span className="text-[var(--text-dim)]">·</span>
          <Money units={item.pot}>+{formatUsdc(item.pot)}</Money>
          <span className="text-[var(--text-dim)]">·</span>
          <span style={{ color: "var(--green-text)" }}>+{item.dElo} ELO</span>
        </span>
      );
    case "match":
      return (
        <span key={key} className="inline-flex items-center gap-2 text-[var(--text-2)]">
          <Tag tone="live">LIVE</Tag>
          <span>@{item.handle}</span>
          <span className="text-[var(--text-dim)]">vs</span>
          <span>@{item.opponent}</span>
          <span className="text-[var(--text-dim)]">·</span>
          <span>{item.game}</span>
          {item.pot != null && (
            <>
              <span className="text-[var(--text-dim)]">·</span>
              <Money units={item.pot}>{formatUsdc(item.pot)} pot</Money>
            </>
          )}
        </span>
      );
    case "challenge":
      return (
        <span key={key} className="inline-flex items-center gap-2 text-[var(--text-2)]">
          <Tag>OPEN</Tag>
          <span>@{item.handle}</span>
          <span className="text-[var(--text-dim)]">·</span>
          <span>{item.game}</span>
          <span className="text-[var(--text-dim)]">·</span>
          <Money units={item.stake}>{formatUsdc(item.stake)} stake</Money>
        </span>
      );
    case "vol":
      return (
        <span key={key} className="inline-flex items-center gap-2 text-[var(--text-2)]">
          <Tag>VOL</Tag>
          <span>{item.game}</span>
          <span className="text-[var(--text-dim)]">·</span>
          <span style={{ color: "var(--gold)" }}>{item.vol}</span>
        </span>
      );
  }
}

export function TickerTape({ items }: { items: TickerItem[] }) {
  if (items.length === 0) {
    // Hide entirely when the tape is empty — better than an empty bar.
    return null;
  }
  // Double the items so the CSS keyframe loops without a gap.
  const doubled = [...items, ...items];
  return (
    <div className="ticker relative flex h-[30px] items-center overflow-hidden border-b border-[var(--line)] bg-[var(--bg-1)]">
      <div
        className="relative z-[2] flex h-full flex-shrink-0 items-center px-3 font-numeric text-[10px] font-semibold uppercase tracking-[0.18em]"
        style={{
          background: "var(--accent)",
          color: "var(--accent-fg)",
          boxShadow: "4px 0 6px -2px color-mix(in oklab, var(--bg) 60%, transparent)",
        }}
      >
        <span
          className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--bg)" }}
        />
        TAPE
      </div>
      <div className="ticker-track flex flex-shrink-0 items-center gap-7 whitespace-nowrap pl-7 font-numeric text-[12px]">
        {doubled.flatMap((item, i) => [
          renderItem(item, `i-${i}`),
          <span
            key={`d-${i}`}
            className="inline-block h-1 w-1 rounded-full"
            style={{ background: "var(--text-dim)" }}
          />,
        ])}
      </div>
    </div>
  );
}
