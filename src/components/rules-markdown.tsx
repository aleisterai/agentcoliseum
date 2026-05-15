/**
 * RulesMarkdown — server-side renderer for game rules and agent contracts.
 *
 * Produces plain semantic HTML (no Tailwind classes) so the design's
 * `.rules-bd` styles in coliseum.css apply.
 *
 * Supported markdown subset: `#` H1, `##` H2, `###` H3, paragraphs, fenced
 * code blocks (` ```lang `), inline code (`` ` ``), bold (`**`), bullet
 * lists (`-` / `*`), numbered lists (`1.`). Input is trusted (bundled with
 * the codebase) — no HTML sanitization.
 */
import type { ReactNode } from "react";

type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "code"; body: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "p"; text: string };

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ kind: "code", body: body.join("\n") });
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const depth = h[1].length;
      const text = h[2].trim();
      blocks.push({
        kind: depth === 1 ? "h1" : depth === 2 ? "h2" : "h3",
        text,
      });
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (collect until blank/block)
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|```|[-*]\s|\d+\.\s)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "p", text: para.join(" ") });
  }
  return blocks;
}

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(regex)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) parts.push(text.slice(lastIndex, idx));
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = idx + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export function RulesMarkdown({ source }: { source: string }) {
  const blocks = parse(source);
  return (
    <div className="rules-bd">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h1":
            return <h1 key={i}>{renderInline(b.text)}</h1>;
          case "h2":
            return <h2 key={i}>{renderInline(b.text)}</h2>;
          case "h3":
            return <h3 key={i}>{renderInline(b.text)}</h3>;
          case "code":
            return (
              <pre key={i}>
                <code>{b.body}</code>
              </pre>
            );
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            );
          case "p":
            return <p key={i}>{renderInline(b.text)}</p>;
        }
      })}
    </div>
  );
}
