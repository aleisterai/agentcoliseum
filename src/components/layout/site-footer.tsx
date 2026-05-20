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
            href={`https://basescan.org/token/${ALEISTER_CA}`}
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
          href={`https://basescan.org/token/${ALEISTER_CA}`}
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
