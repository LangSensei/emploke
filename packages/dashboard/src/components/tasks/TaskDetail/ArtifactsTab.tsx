import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type TaskRecord, taskArtifactUrl } from "../../../api";
import { FileViewer } from "../../viewers/FileViewer";
import { pickViewer, viewerNeedsBlob } from "../../viewers/index";

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

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; content: string | Blob; size: number }
  | { status: "error"; message: string };

export function ArtifactsTab({ task }: ArtifactsTabProps) {
  const artifacts = useMemo(() => extractArtifacts(task), [task]);
  const [selected, setSelected] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  // Auto-select when there's exactly one artifact so the common case
  // (a single report) renders immediately without a manual click.
  useEffect(() => {
    if (artifacts.length === 1 && selected === null) {
      setSelected(artifacts[0]!.name);
    }
  }, [artifacts, selected]);

  // Reset selection if it points at a name that no longer exists in the
  // (now-updated) artifact list. This can happen if the task record is
  // refreshed with a different success.artifacts payload.
  useEffect(() => {
    if (selected && !artifacts.some((a) => a.name === selected)) {
      setSelected(null);
    }
  }, [artifacts, selected]);

  // Fetch the selected artifact, aborting any in-flight request when
  // the selection (or task id) changes.
  useEffect(() => {
    if (!selected) {
      setFetchState({ status: "idle" });
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setFetchState({ status: "loading" });

    const url = taskArtifactUrl(task.id, selected);
    const asBlob = viewerNeedsBlob(selected);
    (async () => {
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) {
          setFetchState({
            status: "error",
            message: `Failed to load artifact (${res.status})`,
          });
          return;
        }
        if (asBlob) {
          const blob = await res.blob();
          setFetchState({ status: "loaded", content: blob, size: blob.size });
        } else {
          const text = await res.text();
          setFetchState({ status: "loaded", content: text, size: text.length });
        }
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") return;
        setFetchState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load artifact",
        });
      }
    })();

    return () => ctrl.abort();
  }, [selected, task.id]);

  const handleSelect = useCallback((name: string) => {
    setSelected(name);
  }, []);

  if (artifacts.length === 0) {
    return (
      <div className="task-detail__body">
        <p className="muted">No artifacts were produced by this task.</p>
      </div>
    );
  }
  return (
    <div className="task-detail__body artifacts-split">
      <div className="artifacts-split__list">
        <ul className="artifact-list">
          {artifacts.map((a, idx) => {
            const isActive = a.name === selected;
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: artifact list is render-only; ordering is server-stable and items are not reordered.
                key={`${a.url}-${idx}`}
                className={`artifact-list__item${isActive ? " artifact-list__item--active" : ""}`}
              >
                <span className="artifact-list__icon" aria-hidden="true">
                  📄
                </span>
                <div className="artifact-list__main">
                  <button
                    type="button"
                    onClick={() => handleSelect(a.name)}
                    className="artifact-list__name artifact-list__name--button"
                    aria-pressed={isActive}
                  >
                    {a.name}
                  </button>
                </div>
                <a
                  href={a.url}
                  className="artifact-list__download"
                  target="_blank"
                  rel="noreferrer noopener"
                  download={a.name}
                  title={`Download ${a.name}`}
                >
                  Download
                </a>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="artifacts-split__preview">
        <ArtifactPreview
          selected={selected}
          state={fetchState}
          downloadUrl={selected ? taskArtifactUrl(task.id, selected) : undefined}
        />
      </div>
    </div>
  );
}

interface ArtifactPreviewProps {
  selected: string | null;
  state: FetchState;
  downloadUrl: string | undefined;
}

function ArtifactPreview({ selected, state, downloadUrl }: ArtifactPreviewProps) {
  if (!selected) {
    return (
      <div className="artifact-viewer artifact-viewer--empty">Select an artifact to preview.</div>
    );
  }
  if (state.status === "loading") {
    return (
      <div className="artifact-viewer artifact-viewer--empty">
        <span className="artifact-viewer__spinner" aria-hidden="true" />
        Loading…
      </div>
    );
  }
  if (state.status === "error") {
    return <div className="artifact-viewer artifact-viewer--error">{state.message}</div>;
  }
  if (state.status === "loaded") {
    // Force-remount the viewer on selection change so internal state
    // (object URLs, JSON parsing memo, iframe doc) does not leak across
    // artifacts even if the dispatcher resolves to the same component.
    const kind = pickViewer(selected);
    return (
      <FileViewer
        key={`${selected}:${kind}`}
        filename={selected}
        content={state.content}
        size={state.size}
        downloadUrl={downloadUrl}
      />
    );
  }
  return null;
}

/** Public helper so the parent can render the tab badge count. */
export function countArtifacts(task: TaskRecord | null): number {
  if (!task) return 0;
  return extractArtifacts(task).length;
}
