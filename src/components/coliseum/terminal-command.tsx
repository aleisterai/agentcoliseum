"use client";

/**
 * Hero-grade terminal command box.
 *
 * Pattern lifted from clawbank.co + shadcn/ui + vercel-cli pages: a
 * slightly-raised mono box, prompt prefix in dimmed accent, the
 * command in primary text, copy button ghost-styled on the right.
 *
 * Differs from `CopyButton` (which is an absolute-positioned overlay
 * for `<pre>` blocks): this is the WHOLE element. Single component,
 * single import.
 *
 * Props
 *   command   the shell command to display + copy
 *   prompt    optional prompt prefix; defaults to "$" (use "▌" for
 *             cursor-style, "→" for arrow-style)
 *   size      "lg" (hero) | "md" (tab body) | "sm" (inline)
 *   ariaLabel for screen readers; copy button has its own label
 *   note      optional caption rendered below the box (small, dim)
 */
import { useState } from "react";

export interface TerminalCommandProps {
  command: string;
  prompt?: string;
  size?: "lg" | "md" | "sm";
  ariaLabel?: string;
  note?: string;
}

export function TerminalCommand({
  command,
  prompt = "$",
  size = "lg",
  ariaLabel,
  note,
}: TerminalCommandProps) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);

  function onClick() {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={`tcmd tcmd-${size}`} aria-label={ariaLabel ?? command}>
      <div className="tcmd-box">
        <span className="tcmd-prompt" aria-hidden="true">
          {prompt}
        </span>
        <code className="tcmd-text">{command}</code>
        <button
          type="button"
          onClick={onClick}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          className={`tcmd-copy ${copied ? "tcmd-copy-ok" : ""} ${hover ? "tcmd-copy-hover" : ""}`}
          aria-label={copied ? "Copied!" : "Copy command to clipboard"}
        >
          {copied ? (
            <>
              <CheckIcon />
              <span className="tcmd-copy-label">Copied</span>
            </>
          ) : (
            <>
              <CopyIcon />
              <span className="tcmd-copy-label">Copy</span>
            </>
          )}
        </button>
      </div>
      {note ? <div className="tcmd-note">{note}</div> : null}

      <style>{`
        .tcmd {
          width: 100%;
          min-width: 0;
        }
        .tcmd-box {
          display: flex;
          align-items: center;
          gap: 12px;
          background: var(--bg-1);
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 14px 14px 14px 18px;
          font-family: var(--font-mono, ui-monospace, "JetBrains Mono", monospace);
          transition: border-color 0.15s, background 0.15s;
          /* Don't let the nowrap <code> child expand the box past
           * the parent's width — the <code> handles its own scroll. */
          min-width: 0;
          max-width: 100%;
        }
        .tcmd-box:hover {
          border-color: var(--line-3);
        }
        .tcmd-lg .tcmd-box {
          padding: 18px 16px 18px 20px;
          border-radius: 10px;
        }
        .tcmd-sm .tcmd-box {
          padding: 10px 10px 10px 14px;
          border-radius: 6px;
        }
        .tcmd-prompt {
          color: var(--gold-dim);
          font-size: 15px;
          line-height: 1;
          font-weight: 500;
          flex-shrink: 0;
          user-select: none;
        }
        .tcmd-lg .tcmd-prompt {
          font-size: 18px;
        }
        .tcmd-text {
          flex: 1 1 0;
          /* min-width: 0 lets the flex item shrink BELOW its
           * intrinsic content width — without this, a long URL
           * forces the flex container (and parent grid) wider. */
          min-width: 0;
          color: var(--text);
          font-size: 14.5px;
          letter-spacing: -0.005em;
          background: transparent;
          padding: 0;
          overflow-x: auto;
          white-space: nowrap;
          font-weight: 500;
          /* Hide scrollbar but keep functional on narrow */
          scrollbar-width: none;
        }
        .tcmd-text::-webkit-scrollbar { display: none; }
        .tcmd-lg .tcmd-text {
          font-size: 17px;
        }
        @media (min-width: 640px) {
          .tcmd-lg .tcmd-text { font-size: 18px; }
        }
        .tcmd-sm .tcmd-text {
          font-size: 13px;
        }
        .tcmd-copy {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
          background: transparent;
          border: 1px solid transparent;
          color: var(--text-mute);
          font-family: inherit;
          font-size: 11.5px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          font-weight: 600;
          padding: 6px 10px;
          border-radius: 5px;
          cursor: pointer;
          transition: all 0.15s;
        }
        .tcmd-copy-hover {
          color: var(--text);
          background: var(--bg-2);
          border-color: var(--line);
        }
        .tcmd-copy-ok {
          color: var(--up, oklch(0.92 0.25 128));
          border-color: color-mix(in oklab, var(--up, oklch(0.92 0.25 128)) 40%, transparent);
        }
        .tcmd-copy svg {
          width: 13px;
          height: 13px;
          stroke: currentColor;
          stroke-width: 1.8;
          fill: none;
        }
        .tcmd-note {
          margin-top: 10px;
          font-size: 12px;
          color: var(--text-mute);
          padding-left: 4px;
          line-height: 1.5;
        }
        /* Mobile: hide the "Copy" label, keep icon only */
        @media (max-width: 520px) {
          .tcmd-copy-label { display: none; }
          .tcmd-copy { padding: 8px; }
        }
      `}</style>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
