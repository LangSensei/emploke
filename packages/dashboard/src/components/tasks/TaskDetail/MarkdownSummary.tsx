import type { JSX } from "react";

/**
 * Minimal-footprint markdown renderer used by the Tasks Overview tab.
 *
 * The dashboard intentionally ships no markdown library (see
 * `packages/dashboard/package.json` dependencies — only
 * `@codemirror/lang-markdown`, which is for *editing* not rendering).
 * The mission-A brief is explicit: "No new dependencies. If a markdown
 * renderer is needed and one isn't already installed, reuse whatever
 * is used elsewhere in the dashboard."
 *
 * Nothing is installed, so this module supplies a tiny safe-by-construction
 * renderer that covers the markdown idioms the Copilot/runtime `success.output`
 * payload actually contains:
 *
 *   - Headings (`# `, `## `, `### `)
 *   - Bold (`**x**`), italic (`*x*` / `_x_`), inline code (`` `x` ``)
 *   - Links (`[text](url)`) — `http(s):` / `mailto:` only; other schemes are
 *     rendered as plain text so a malicious agent output can't smuggle
 *     `javascript:` URLs into the dashboard.
 *   - Unordered (`- ` / `* `) and ordered (`1. `) lists
 *   - Fenced code blocks (```` ``` ````)
 *   - Blank-line-separated paragraphs
 *
 * Inline values are emitted as React nodes (never `dangerouslySetInnerHTML`),
 * so user text can never become an HTML injection. Tables, blockquotes,
 * images, and HTML passthrough are intentionally NOT supported.
 */

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; lang: string | null; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]?.startsWith("```")) {
        body.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }
    // Blank line → paragraph boundary
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Heading
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: h[2] ?? "" });
      i++;
      continue;
    }
    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }
    // Paragraph (greedy until blank line or block-starting line)
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (
        next.trim() === "" ||
        next.startsWith("```") ||
        /^(#{1,3})\s+/.test(next) ||
        /^[-*]\s+/.test(next) ||
        /^\d+\.\s+/.test(next)
      ) {
        break;
      }
      para.push(next);
      i++;
    }
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

/** Render inline markdown (bold, italic, code, links) as React nodes. */
function renderInline(src: string): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = [];
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      out.push(buf);
      buf = "";
    }
  };
  while (i < src.length) {
    const c = src[i] ?? "";
    // Inline code: `…`
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push(<code key={out.length}>{src.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    // Bold: **…**
    if (c === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        out.push(<strong key={out.length}>{renderInline(src.slice(i + 2, end))}</strong>);
        i = end + 2;
        continue;
      }
    }
    // Italic: *…* (not **) or _…_
    if ((c === "*" || c === "_") && src[i + 1] !== c) {
      const end = src.indexOf(c, i + 1);
      if (end > i) {
        flush();
        out.push(<em key={out.length}>{renderInline(src.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
    }
    // Link: [text](url)
    if (c === "[") {
      const close = src.indexOf("]", i + 1);
      if (close > i && src[close + 1] === "(") {
        const urlEnd = src.indexOf(")", close + 2);
        if (urlEnd > close) {
          const text = src.slice(i + 1, close);
          const rawUrl = src.slice(close + 2, urlEnd).trim();
          const safe = /^(https?:|mailto:)/i.test(rawUrl);
          flush();
          if (safe) {
            out.push(
              <a key={out.length} href={rawUrl} target="_blank" rel="noreferrer noopener">
                {text}
              </a>,
            );
          } else {
            out.push(`[${text}](${rawUrl})`);
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function renderBlock(b: Block, key: number): JSX.Element {
  switch (b.kind) {
    case "heading": {
      const Tag = `h${b.level}` as "h1" | "h2" | "h3";
      return <Tag key={key}>{renderInline(b.text)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{renderInline(b.text)}</p>;
    case "ul":
      return (
        <ul key={key}>
          {b.items.map((it, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are derived from immutable parsed markdown and never reordered.
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key}>
          {b.items.map((it, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are derived from immutable parsed markdown and never reordered.
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre key={key} className="md-code">
          <code>{b.text}</code>
        </pre>
      );
  }
}

/**
 * Render a markdown source string as React. Wraps everything in a
 * single `<div class="md">` so consumers can scope typography rules.
 */
export function MarkdownSummary({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  if (blocks.length === 0) {
    return <p className="muted">(empty)</p>;
  }
  return <div className="md">{blocks.map((b, idx) => renderBlock(b, idx))}</div>;
}
