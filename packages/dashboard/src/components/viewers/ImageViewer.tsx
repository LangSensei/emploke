import { useEffect, useMemo } from "react";
import type { ViewerProps } from "./types";

/**
 * Image preview — wraps the binary Blob in an object URL and revokes
 * it on unmount / content change so we don't leak GPU/CPU memory in
 * long-lived dashboard sessions.
 */
export default function ImageViewer({ content, filename }: ViewerProps) {
  const url = useMemo(() => {
    if (content instanceof Blob) return URL.createObjectURL(content);
    return null;
  }, [content]);
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);
  if (!url) {
    return (
      <div className="artifact-viewer artifact-viewer--empty">
        Unable to preview image (no binary content).
      </div>
    );
  }
  return (
    <div className="artifact-viewer artifact-viewer--image">
      <img src={url} alt={filename} className="artifact-viewer__img" />
    </div>
  );
}
