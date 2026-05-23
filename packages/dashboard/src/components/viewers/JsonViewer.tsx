import { useMemo } from "react";
import type { ViewerProps } from "./types";

/**
 * JSON preview — try to pretty-print; fall back to raw content on parse
 * failure so a malformed artifact is still legible.
 */
export default function JsonViewer({ content }: ViewerProps) {
  const raw = typeof content === "string" ? content : "";
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return null;
    }
  }, [raw]);
  return (
    <pre className="artifact-viewer artifact-viewer--code">
      <code>{pretty ?? raw}</code>
    </pre>
  );
}
