import type { ViewerProps } from "./types";

/**
 * Plain-text preview — `<pre>` with wrapping so long log lines remain
 * readable instead of forcing a horizontal scrollbar across the whole
 * detail pane.
 */
export default function TextViewer({ content }: ViewerProps) {
  const text = typeof content === "string" ? content : "";
  return <pre className="artifact-viewer artifact-viewer--text">{text}</pre>;
}
