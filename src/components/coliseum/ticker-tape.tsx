/**
 * TickerTape — uses the design's exact .ticker/.ticker-label/.ticker-track
 * /.ticker-item/.ticker-dot class structure from shared.css so spacing,
 * masking, and animation match the design without further CSS-in-JS work.
 */
import { formatUsdc } from "./money";

export type TickerItem =
  | { kind: "win"; handle: string; game: string; pot: number; dElo: number }
  | { kind: "upset"; handle: string; beatHandle: string; game: string; pot: number; dElo: number }
  | { kind: "match"; handle: string; opponent: string; game: string; pot?: number }
  | { kind: "challenge"; handle: string; game: string; stake: number }
  | { kind: "vol"; game: string; vol: string };

function renderItem(item: TickerItem, key: string): React.ReactNode {
  switch (item.kind) {
    case "win":
      return (
        <span key={key} className="ticker-item">
          <span className="tag up" style={{ color: "var(--green-text)" }}>WIN</span>
          @{item.handle} <span className="dim">·</span> {item.game}{" "}
          <span className="dim">·</span> <span className="gold">+{formatUsdc(item.pot)}</span>{" "}
          <span className="dim">·</span> <span className="up">+{item.dElo} ELO</span>
        </span>
      );
    case "upset":
      return (
        <span key={key} className="ticker-item">
          <span className="tag" style={{ color: "var(--gold)" }}>UPSET</span>
          @{item.handle} beat @{item.beatHandle} <span className="dim">·</span> {item.game}{" "}
          <span className="dim">·</span> <span className="gold">+{formatUsdc(item.pot)}</span>{" "}
          <span className="dim">·</span> <span className="up">+{item.dElo} ELO</span>
        </span>
      );
    case "match":
      return (
        <span key={key} className="ticker-item">
          <span className="tag live" style={{ color: "var(--ox-bright)" }}>LIVE</span>
          @{item.handle} <span className="dim">vs</span> @{item.opponent}{" "}
          <span className="dim">·</span> {item.game}
          {item.pot != null && (
            <>
              {" "}
              <span className="dim">·</span> <span className="gold">{formatUsdc(item.pot)} pot</span>
            </>
          )}
        </span>
      );
    case "challenge":
      return (
        <span key={key} className="ticker-item">
          <span className="tag">OPEN</span>
          @{item.handle} <span className="dim">·</span> {item.game} <span className="dim">·</span>{" "}
          <span className="gold">{formatUsdc(item.stake)} stake</span>
        </span>
      );
    case "vol":
      return (
        <span key={key} className="ticker-item">
          <span className="tag">VOL</span>
          {item.game} <span className="dim">·</span> <span className="gold">{item.vol}</span>
        </span>
      );
  }
}

export function TickerTape({ items }: { items: TickerItem[] }) {
  if (items.length === 0) return null;
  // The design doubles items so the CSS keyframe loops without a gap.
  const doubled = [...items, ...items];
  return (
    <div className="ticker">
      <div className="ticker-label">
        <span className="pulse-dot" style={{ background: "var(--bg)", marginRight: 6 }} />
        TAPE
      </div>
      <div className="ticker-track">
        {doubled.map((item, i) => (
          <span key={`grp-${i}`} style={{ display: "contents" }}>
            {renderItem(item, `i-${i}`)}
            <span className="ticker-dot" />
          </span>
        ))}
      </div>
    </div>
  );
}
