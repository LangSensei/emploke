import type { TaskRecord } from "../../../api";

export interface ArtifactsTabProps {
  task: TaskRecord;
}

/**
 * Lift `(success?.deliverable as { artifacts?: ... } | undefined)?.artifacts`
 * into a typed array we can render. The Mission-A spec is explicit:
 *
 *   "Artifacts tab count matches `success.deliverable.artifacts?.length ?? 0`"
 *
 * `success.deliverable` is declared `unknown` on TaskRecord (it's an
 * extension point for the agent-driven completion model), so we
 * carefully narrow without trusting its shape. Items can be either
 * plain strings (path / URL) or richer objects with `{ name, size,
 * url, path }` — both shapes are normalised here.
 */
interface NormalArtifact {
  name: string;
  url: string | null;
  size: number | null;
}

function extractArtifacts(task: TaskRecord): NormalArtifact[] {
  const deliverable = task.success?.deliverable as { artifacts?: unknown } | undefined;
  const raw = deliverable?.artifacts;
  if (!Array.isArray(raw)) {
    // Fall back to the legacy top-level `success.artifacts: string[]`
    // so we don't drop artifacts written by older runtimes.
    const legacy = task.success?.artifacts;
    if (!Array.isArray(legacy)) return [];
    return legacy.map((s) => normaliseString(String(s)));
  }
  return raw.map((entry) => {
    if (typeof entry === "string") return normaliseString(entry);
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const name =
        typeof obj.name === "string"
          ? obj.name
          : typeof obj.path === "string"
            ? basename(obj.path)
            : "(unnamed)";
      const url =
        typeof obj.url === "string" ? obj.url : typeof obj.path === "string" ? obj.path : null;
      const size = typeof obj.size === "number" ? obj.size : null;
      return { name, url, size };
    }
    return { name: "(unknown)", url: null, size: null };
  });
}

function normaliseString(s: string): NormalArtifact {
  return { name: basename(s) || s, url: s, size: null };
}

function basename(p: string): string {
  const cleaned = p.split(/[?#]/, 1)[0] ?? p;
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function formatBytes(n: number | null): string | null {
  if (n === null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function ArtifactsTab({ task }: ArtifactsTabProps) {
  const artifacts = extractArtifacts(task);
  if (artifacts.length === 0) {
    return (
      <div className="task-detail__body">
        <p className="muted">No artifacts were produced by this task.</p>
      </div>
    );
  }
  return (
    <div className="task-detail__body">
      <ul className="artifact-list">
        {artifacts.map((a, idx) => {
          const sizeLabel = formatBytes(a.size);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: artifact list is render-only; ordering is server-stable and items are not reordered.
            <li key={`${a.url ?? a.name}-${idx}`} className="artifact-list__item">
              <span className="artifact-list__icon" aria-hidden="true">
                📄
              </span>
              <div className="artifact-list__main">
                {a.url ? (
                  <a
                    href={a.url}
                    className="artifact-list__name"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {a.name}
                  </a>
                ) : (
                  <span className="artifact-list__name">{a.name}</span>
                )}
                {sizeLabel && <span className="artifact-list__size muted">{sizeLabel}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Public helper so the parent can render the tab badge count. */
export function countArtifacts(task: TaskRecord | null): number {
  if (!task) return 0;
  return extractArtifacts(task).length;
}
