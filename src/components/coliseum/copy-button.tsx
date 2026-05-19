"use client";

/**
 * Subtle copy-to-clipboard button positioned absolute-top-right of its
 * parent (which must be `position: relative`). Text-only feedback — no
 * background flash on copy, just a 1.2s color/label swap.
 */
import { useState } from "react";

export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);

  function onClick() {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 1,
        background: "color-mix(in oklab, var(--bg) 92%, transparent)",
        color: copied ? "var(--green-text)" : hover ? "var(--text)" : "var(--text-mute)",
        border: `1px solid ${copied ? "var(--green-text)" : "var(--line)"}`,
        borderRadius: 3,
        padding: "3px 8px",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        cursor: "pointer",
        fontWeight: 600,
        transition: "color 0.15s, border-color 0.15s",
      }}
    >
      {copied ? "✓ copied" : label}
    </button>
  );
}
