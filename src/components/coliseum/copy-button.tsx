"use client";

/**
 * Tiny copy-to-clipboard button used in the docs/agents page.
 * Absolute-positioned to the top-right of its parent (which must be relative).
 */
import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function onClick() {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 1,
        background: copied ? "var(--green)" : "var(--bg-3)",
        color: copied ? "var(--bg)" : "var(--text-2)",
        border: "1px solid var(--line)",
        borderRadius: 4,
        padding: "4px 10px",
        fontSize: 10.5,
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        cursor: "pointer",
        fontWeight: 600,
      }}
    >
      {copied ? "✓ copied" : "copy"}
    </button>
  );
}
