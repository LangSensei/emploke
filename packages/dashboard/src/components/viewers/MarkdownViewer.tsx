import { MarkdownSummary } from "../tasks/TaskDetail/MarkdownSummary";
import type { ViewerProps } from "./types";

/**
 * Markdown preview — reuses the in-house `MarkdownSummary` renderer so
 * we don't pull in `react-markdown` just for the artifact preview. The
 * shared renderer is safe-by-construction (never uses
 * `dangerouslySetInnerHTML`).
 */
export default function MarkdownViewer({ content }: ViewerProps) {
  const text = typeof content === "string" ? content : "";
  return (
    <div className="artifact-viewer artifact-viewer--markdown">
      <MarkdownSummary source={text} />
    </div>
  );
}
