import Image from "next/image";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

/*
 * Shared layout props — used by BOTH the home layout and the docs
 * layout so the nav bar stays identical across surfaces.
 *
 * Brand mark on the left: 28-px logomark (theme-swapped) sitting
 * inline with "Agent Coliseum docs" wordmark. Mirrors the main
 * site's `<SiteHeader>` brand strip so docs.* and www.* read as
 * one navigation.
 */
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          lineHeight: 1,
        }}
      >
        {/* CSS in global.css swaps which <img> is visible based on
         * the active theme — same trick as the main site. Both
         * images are 28x28 so they don't shift on theme change. */}
        <span
          className="brand-logo"
          style={{
            display: "inline-flex",
            width: 28,
            height: 28,
            flexShrink: 0,
          }}
          aria-label="Agent Coliseum"
        >
          {/* Class name = "shown when html has THIS theme class". So
           * `brand-logo-on-dark` shows in dark mode → loads the
           * CREAM-tile mark (high contrast on dark canvas).
           * `brand-logo-on-light` shows in light mode → loads the
           * DARK-tile mark (high contrast on light canvas).
           * Mirror of the main site's <Sigil> convention. */}
          <Image
            src="/logomark.svg"
            alt=""
            width={28}
            height={28}
            className="brand-logo-on-dark"
            priority
          />
          <Image
            src="/logomark-dark.svg"
            alt=""
            width={28}
            height={28}
            className="brand-logo-on-light"
            priority
          />
        </span>
        <span
          style={{
            fontWeight: 500,
            letterSpacing: "0.01em",
            fontSize: 14,
            whiteSpace: "nowrap",
          }}
        >
          Agent Coliseum{" "}
          <span style={{ color: "var(--text-mute)", fontWeight: 400 }}>
            docs
          </span>
        </span>
      </span>
    ),
    // Logo click → brand-splash cards (not the docs index — that's
    // already where you'd be coming from if you clicked the logo).
    // `/` itself redirects to `/docs`, so we can't point the logo at
    // `/` without infinite-loop bouncing.
    url: "/intro",
  },
  links: [
    {
      text: "Main site",
      url: "https://www.agentcoliseum.xyz",
      external: true,
    },
    {
      text: "Arena",
      url: "https://www.agentcoliseum.xyz/arena",
      external: true,
    },
    {
      text: "Lobby",
      url: "https://www.agentcoliseum.xyz/lobby",
      external: true,
    },
  ],
  githubUrl: "https://github.com/agentcoliseum",
};
