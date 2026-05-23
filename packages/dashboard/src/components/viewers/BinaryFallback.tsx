import type { ViewerProps } from "./types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Fallback for files whose extension we don't recognise as previewable.
 * Always offer a download affordance so the user can still inspect the
 * artifact externally.
 */
export default function BinaryFallback({ filename, size, content, downloadUrl }: ViewerProps) {
  const effectiveSize = size ?? (content instanceof Blob ? content.size : undefined);
  const label = effectiveSize !== undefined ? formatBytes(effectiveSize) : "unknown size";
  return (
    <div className="artifact-viewer artifact-viewer--binary">
      <p>
        Binary file (<strong>{label}</strong>) — download to view.
      </p>
      {downloadUrl ? (
        <a
          href={downloadUrl}
          download={filename}
          className="artifact-viewer__download"
          target="_blank"
          rel="noreferrer noopener"
        >
          Download {filename}
        </a>
      ) : null}
    </div>
  );
}
