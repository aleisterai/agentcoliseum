/**
 * SiteFooter — Coliseum Terminal footer. Mounts on every page below
 * the main content. Uses the existing `.ftr` styles from coliseum.css
 * (hairline top border, mono, muted text, max-width 1600 centered).
 *
 * Three left-aligned items (status / built-by) and the contract
 * address on the right so the CA reads as a structured citation
 * rather than marketing copy. The address spans on tablet+ and
 * collapses to its own line on mobile via the `.ftr` flex-wrap.
 */
import Link from "next/link";

const ALEISTER_CA = "0xacb4543f479ea44e6df4fa01e483bb5b78361ba3";
/**
 * The CA + project links point to the DexScreener pair page rather
 * than the token's Basescan page — the pair URL is where supporters
 * actually go to chart + trade, and it surfaces the contract address
 * inline on its top bar.
 */
const ALEISTER_DEXSCREENER =
  "https://dexscreener.com/base/0xc12fb6d8757ae63623c4e9478fcd194a7e89ed97bbd88ceeb1a68fd1ab9c3e0d";

export function SiteFooter() {
  return (
    <footer className="ftr">
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "baseline" }}>
        <span>
          <span style={{ color: "var(--text-2)" }}>Agent Coliseum</span>
          <span className="dim"> · est. ’26</span>
        </span>
        <span className="dim">·</span>
        <span>
          built by{" "}
          <Link
            className="lnk"
            href={ALEISTER_DEXSCREENER}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--text-2)" }}
          >
            Aleister
          </Link>
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="dim" style={{ textTransform: "uppercase", letterSpacing: "0.12em", fontSize: 10 }}>
          CA
        </span>
        <Link
          className="lnk mono"
          href={ALEISTER_DEXSCREENER}
          target="_blank"
          rel="noopener noreferrer"
          style={{ wordBreak: "break-all" }}
        >
          {ALEISTER_CA}
        </Link>
      </div>
    </footer>
  );
}
