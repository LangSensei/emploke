import type { ViewerProps } from "./types";

/**
 * Code preview — plain monospaced block. Syntax highlighting is
 * explicitly out of scope for this commit (would require a heavyweight
 * highlighter dependency).
 */
export default function CodeViewer({ content }: ViewerProps) {
  const text = typeof content === "string" ? content : "";
  return (
    <pre className="artifact-viewer artifact-viewer--code">
      <code>{text}</code>
    </pre>
  );
}
