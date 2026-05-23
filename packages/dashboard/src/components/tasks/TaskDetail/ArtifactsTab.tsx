import { type TaskRecord, taskArtifactUrl } from "../../../api";

export interface ArtifactsTabProps {
  task: TaskRecord;
}

interface NormalArtifact {
  name: string;
  url: string;
}

/**
 * Issue #181: `success.artifacts` is now the only artifact source.
 * Entries are absolute fs paths captured by `applyTerminal` at
 * terminal time; the basename is what we display + what the server
 * accepts as the URL segment.
 */
function extractArtifacts(task: TaskRecord): NormalArtifact[] {
  const list = task.success?.artifacts ?? [];
  return list.map((absPath) => {
    const name = basename(absPath);
    return {
      name,
      url: taskArtifactUrl(task.id, name),
    };
  });
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
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
        {artifacts.map((a, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: artifact list is render-only; ordering is server-stable and items are not reordered.
          <li key={`${a.url}-${idx}`} className="artifact-list__item">
            <span className="artifact-list__icon" aria-hidden="true">
              📄
            </span>
            <div className="artifact-list__main">
              <a
                href={a.url}
                className="artifact-list__name"
                target="_blank"
                rel="noreferrer noopener"
              >
                {a.name}
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Public helper so the parent can render the tab badge count. */
export function countArtifacts(task: TaskRecord | null): number {
  if (!task) return 0;
  return extractArtifacts(task).length;
}
