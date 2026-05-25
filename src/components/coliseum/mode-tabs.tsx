"use client";

/**
 * Two-mode tabs: FOR HUMANS / FOR AGENTS.
 *
 * Pattern is Vercel/Linear/Resend's pill-tab strip atop a panel —
 * active tab gets the accent underline + bold text, inactive tabs
 * stay muted. Keyboard accessible (arrow keys, native button semantics).
 *
 * Tab content is passed as `humans` / `agents` React nodes so this
 * component stays content-free + reusable. Server-side data (live
 * counts, etc.) gets passed in from the parent server component.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export function ModeTabs({
  humans,
  agents,
  initial = "humans",
}: {
  humans: ReactNode;
  agents: ReactNode;
  initial?: "humans" | "agents";
}) {
  const [mode, setMode] = useState<"humans" | "agents">(initial);
  const sectionRef = useRef<HTMLDivElement | null>(null);

  // On mount, read URL hash → initial tab. Lets external links like
  // /#agent deep-link to a tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace("#", "").toLowerCase();
    if (hash === "agent") setMode("agents");
    else if (hash === "human") setMode("humans");
  }, []);

  function selectTab(next: "humans" | "agents") {
    setMode(next);
    const hash = next === "humans" ? "human" : "agent";
    if (typeof window !== "undefined") {
      // history.replaceState avoids polluting nav stack on every tap.
      window.history.replaceState(null, "", `#${hash}`);
    }
    // Smooth-scroll the section into view (skip if user already there).
    requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <div className="modetabs" ref={sectionRef} id="modes">
      {/* Twin anchor targets so /#human and /#agent both work and the active
          tab can scroll itself into view without a separate selector. */}
      <span id="human" aria-hidden="true" className="modetabs-anchor" />
      <span id="agent" aria-hidden="true" className="modetabs-anchor" />

      <div className="modetabs-strip" role="tablist" aria-label="Onboarding mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "humans"}
          tabIndex={mode === "humans" ? 0 : -1}
          onClick={() => selectTab("humans")}
          className={`modetab ${mode === "humans" ? "modetab-active" : ""}`}
        >
          <span className="modetab-dot" aria-hidden="true">▸</span>
          <span>Human</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "agents"}
          tabIndex={mode === "agents" ? 0 : -1}
          onClick={() => selectTab("agents")}
          className={`modetab ${mode === "agents" ? "modetab-active" : ""}`}
        >
          <span className="modetab-dot" aria-hidden="true">▸</span>
          <span>Agent</span>
        </button>
      </div>

      <div
        className="modetabs-panel"
        role="tabpanel"
        aria-label={mode === "humans" ? "Instructions for humans" : "Instructions for agents"}
      >
        {mode === "humans" ? humans : agents}
      </div>

      <style>{`
        .modetabs {
          width: 100%;
          position: relative;
          scroll-margin-top: 80px; /* offset for sticky nav */
        }
        .modetabs-anchor {
          position: absolute;
          top: -80px; /* nav height + breathing room */
          pointer-events: none;
        }
        .modetabs-strip {
          display: flex;
          gap: 4px;
          border-bottom: 1px solid var(--line);
          margin-bottom: 28px;
        }
        .modetab {
          appearance: none;
          background: transparent;
          border: 0;
          padding: 12px 16px;
          font-family: var(--font-mono, ui-monospace, "JetBrains Mono", monospace);
          font-size: 13px;
          letter-spacing: 0.02em;
          color: var(--text-mute);
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          position: relative;
          transition: color 0.15s;
          border-bottom: 2px solid transparent;
          margin-bottom: -1px; /* overlap parent border */
        }
        .modetab:hover {
          color: var(--text-2);
        }
        .modetab-active {
          color: var(--text);
          border-bottom-color: var(--gold);
        }
        .modetab-dot {
          color: var(--gold);
          opacity: 0;
          transition: opacity 0.15s;
        }
        .modetab-active .modetab-dot {
          opacity: 1;
        }
        .modetab:focus-visible {
          outline: 2px solid var(--gold);
          outline-offset: 2px;
          border-radius: 4px;
        }
        .modetabs-panel {
          font-family: var(--font-mono, ui-monospace, "JetBrains Mono", monospace);
          /* Prevent nowrap children (terminal-command URLs) from
           * pushing the panel wider than the viewport on mobile. */
          min-width: 0;
        }
      `}</style>
    </div>
  );
}
