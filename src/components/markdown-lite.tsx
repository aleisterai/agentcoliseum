/**
 * MarkdownLite — server-side renderer for the small subset of Markdown that
 * our game-rules content uses: H1/H2/H3, paragraphs, inline code, fenced
 * code blocks, bold, and the occasional bullet list. Intentionally tiny
 * so we don't pull in a full markdown lib for one feature.
 *
 * Input is treated as trusted — these strings ship with the codebase, not
 * user input — so we don't sanitize HTML. If we ever serve user-authored
 * markdown here, swap this for `marked` or `remark` with sanitizer.
 */

interface MarkdownLiteProps {
  source: string;
  className?: string;
}

type Block =
  | { kind: "heading"; depth: 1 | 2 | 3; text: string }
  | { kind: "code"; lang: string; body: string }
  | { kind: "ul"; items: string[] }
  | { kind: "p"; text: string };

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      blocks.push({ kind: "code", lang, body: body.join("\n") });
      continue;
    }

    // headings
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      blocks.push({ kind: "heading", depth: h[1].length as 1 | 2 | 3, text: h[2].trim() });
      i++;
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // paragraph (collects until blank or block start)
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|```|[-*]\s)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "p", text: para.join(" ") });
  }
  return blocks;
}

function renderInline(text: string): React.ReactNode {
  // Render inline: `code`, **bold**, plain text. Process in a single pass.
  const parts: React.ReactNode[] = [];
  // Pattern matches: backtick code OR double-asterisk bold OR plain run.
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(regex)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) parts.push(text.slice(lastIndex, idx));
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(
        <code key={key++} className="rounded-sm bg-secondary/60 px-1 font-numeric text-[0.95em] text-foreground/90">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      parts.push(
        <strong key={key++} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    }
    lastIndex = idx + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export function MarkdownLite({ source, className }: MarkdownLiteProps) {
  const blocks = parse(source);
  return (
    <div className={`flex flex-col gap-3 text-sm leading-relaxed text-foreground/85 ${className ?? ""}`}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            if (b.depth === 1) {
              return (
                <h2 key={i} className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                  {renderInline(b.text)}
                </h2>
              );
            }
            if (b.depth === 2) {
              return (
                <h3 key={i} className="mt-2 text-base font-semibold uppercase tracking-[0.14em] text-foreground/90">
                  {renderInline(b.text)}
                </h3>
              );
            }
            return (
              <h4 key={i} className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {renderInline(b.text)}
              </h4>
            );
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded-md border border-border bg-background/60 p-3 font-numeric text-[11px] leading-relaxed text-foreground/85"
              >
                {b.body}
              </pre>
            );
          case "ul":
            return (
              <ul key={i} className="ml-4 list-disc space-y-1 text-sm">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case "p":
            return (
              <p key={i} className="text-sm leading-relaxed">
                {renderInline(b.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
