import type { Metadata } from "next";

/**
 * /og-preview — internal review surface for OG card design variants.
 *
 * NOT for SEO. `noindex` + disallowed in robots.txt. This page exists
 * so anyone (designer, founder, me) can compare the three rendered
 * variants side-by-side before the framework is approved.
 *
 * Each variant is a separate route under /og-preview/{a,b,c}/route.tsx
 * that returns a 1200×630 PNG via next/og's ImageResponse.
 */
export const metadata: Metadata = {
  title: "OG card design preview",
  robots: { index: false, follow: false },
};

const VARIANTS = [
  {
    id: "a",
    name: "Variant A — Terminal",
    blurb:
      "Mono-heavy. `$ /path` as the command. Best for developer/docs surfaces and the `npx` onboarding ritual.",
  },
  {
    id: "b",
    name: "Variant B — Editorial poster",
    blurb:
      "Big display headline (88px white + gold). Subhead. Magazine/movie-poster gravitas. Best for marketing pages.",
  },
  {
    id: "c",
    name: "Variant C — Data-rich / chip-grid",
    blurb:
      "Brand + route in eyebrow. Headline + attribute chips (USDC stakes · MCP-native · etc.). Best for platform pages.",
  },
];

export default function OGPreview() {
  return (
    <main className="page" id="page">
      <header className="title-strip" style={{ marginBottom: 24 }}>
        <div>
          <h1 className="page-title">OG card design</h1>
          <p className="page-sub">
            Three candidate frameworks. Pick one (or mix) and I&apos;ll codify
            it as the reusable template every page uses.
          </p>
        </div>
      </header>

      <div className="og-preview-list">
        {VARIANTS.map((v) => (
          <section key={v.id} className="og-preview-item">
            <div className="og-preview-meta">
              <h2 className="og-preview-name">{v.name}</h2>
              <p className="og-preview-blurb">{v.blurb}</p>
              <p className="og-preview-url mono">
                <a href={`/og-preview/${v.id}`} target="_blank" rel="noreferrer">
                  /og-preview/{v.id} →
                </a>
              </p>
            </div>
            <div className="og-preview-card">
              <img
                src={`/og-preview/${v.id}`}
                alt={`OG card ${v.name}`}
                width={1200}
                height={630}
              />
            </div>
          </section>
        ))}
      </div>

      <style>{`
        .og-preview-list {
          display: grid;
          gap: 48px;
          padding-bottom: 80px;
        }
        .og-preview-item {
          display: grid;
          gap: 16px;
        }
        .og-preview-meta { padding: 0 4px; }
        .og-preview-name {
          font-family: var(--font-mono);
          font-size: 14px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--gold);
          margin: 0 0 6px;
        }
        .og-preview-blurb {
          font-size: 15px;
          color: var(--text-2);
          margin: 0 0 8px;
          max-width: 720px;
          line-height: 1.55;
        }
        .og-preview-url { font-size: 12px; color: var(--text-mute); margin: 0; }
        .og-preview-url a { color: var(--gold-dim); text-decoration: none; }
        .og-preview-url a:hover { color: var(--gold); }

        .og-preview-card {
          width: 100%;
          max-width: 960px;
          aspect-ratio: 1200 / 630;
          border: 1px solid var(--line);
          border-radius: 12px;
          overflow: hidden;
          background: var(--bg-1);
        }
        .og-preview-card img {
          width: 100%;
          height: 100%;
          display: block;
        }
      `}</style>
    </main>
  );
}
