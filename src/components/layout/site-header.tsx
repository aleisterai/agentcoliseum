"use client";

/**
 * SiteHeader — Coliseum Terminal header. Uses the design's class names
 * verbatim (.hdr, .hdr-inner, .hdr-brand, .hdr-nav, .hdr-right, .hdr-status,
 * .hdr-burger, .hdr-mobile-menu, .btn-connect, .theme-toggle) so the layout
 * is bit-for-bit the design.
 *
 * Mobile menu is a slide-down panel anchored to the header bottom; opens
 * via the hamburger and closes on link/outside click. Theme toggle stays
 * visible on every breakpoint so users can flip light/dark from the bar.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTweaks } from "@/lib/use-tweaks";
import { HeaderWallet } from "./header-wallet";

type NavItem = {
  href: string;
  label: string;
  /** Cross-origin link → opens in a new tab, no isActive highlight. */
  external?: boolean;
};

const NAV: readonly NavItem[] = [
  { href: "/arena", label: "Arena" },
  { href: "/lobby", label: "Lobby" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/agents", label: "Agents" },
  { href: "/live", label: "Live" },
  { href: "https://docs.agentcoliseum.xyz", label: "Docs", external: true },
];

function Sigil({ size = 44 }: { size?: number }) {
  // Brand logomark. The art is a 512x512 pixel-art SVG (rendered
  // small here, so the chunky pixels are part of the look). Two
  // variants, each a self-contained tile with its own background:
  //   logomark.svg       → bone/cream tile (#f3eee5), DEEP-lime + red
  //                        → high-contrast on DARK pages
  //   logomark-dark.svg  → dark-brown tile (#1a1411), BRIGHT-lime + red
  //                        → high-contrast on LIGHT pages
  // CSS swaps via data-theme so we don't need a client-side theme
  // read — the SSR markup already hides the wrong variant.
  return (
    <span
      className="logomark"
      style={{
        display: "inline-flex",
        width: size,
        height: size,
        lineHeight: 0,
      }}
      aria-label="Agent Coliseum"
    >
      {/* `display` is set by CSS (.logomark-light / .logomark-dark
          rules below) so the theme attribute on <html> decides which
          variant shows. Class name = which THEME it's shown in (not
          which file). `logomark-dark` is shown in dark mode →
          loads the bone-tile so it pops on the dark page. */}
      <img
        src="/logomark-dark.svg"
        alt=""
        className="logomark-light"
        width={size}
        height={size}
      />
      <img
        src="/logomark.svg"
        alt=""
        className="logomark-dark"
        width={size}
        height={size}
      />
    </span>
  );
}

function isActive(pathname: string, item: NavItem): boolean {
  // External cross-origin items never highlight as "active" in main-site nav.
  if (item.external) return false;
  if (item.href === "/") return pathname === "/";
  return pathname.startsWith(item.href);
}

export function SiteHeader() {
  const pathname = usePathname();
  const [, update] = useTweaks();
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  // Close mobile menu on outside click and on route changes.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  return (
    <header className="hdr" ref={headerRef}>
      <div className="hdr-inner">
        <Link className="hdr-brand" href="/">
          <span style={{ color: "var(--accent-text)" }}>
            <Sigil size={44} />
          </span>
          <span className="hdr-brand-name">Agent Coliseum</span>
        </Link>
        <nav className="hdr-nav">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={isActive(pathname, n) ? "active" : ""}
              {...(n.external
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="hdr-right">
          <span className="hdr-status">
            <span className="pulse-dot" style={{ background: "var(--green)" }} />
            base mainnet · x402
          </span>
          <button
            type="button"
            className="theme-toggle"
            aria-label="Toggle theme"
            title="Toggle light / dark"
            onClick={() =>
              update({
                theme:
                  document.documentElement.getAttribute("data-theme") === "light"
                    ? "dark"
                    : "light",
              })
            }
          >
            <svg className="i-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </svg>
            <svg className="i-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          </button>
          <HeaderWallet />
          <button
            type="button"
            className="hdr-burger"
            aria-label="Menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
        </div>
      </div>
      <div className={"hdr-mobile-menu" + (open ? " open" : "")}>
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={isActive(pathname, n) ? "active" : ""}
            {...(n.external
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            {n.label}
          </Link>
        ))}
        <div className="menu-divider" />
        <div className="menu-status">
          <span className="pulse-dot" style={{ background: "var(--green)" }} />
          base mainnet · x402
        </div>
        <div className="menu-divider" />
        <HeaderWallet fullWidth />
      </div>
    </header>
  );
}
