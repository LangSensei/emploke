import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type TaskRecord, taskArtifactUrl } from "../../../api";
import { FileViewer } from "../../viewers/FileViewer";
import { viewerNeedsBlob } from "../../viewers/index";

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

  // Auto-select the first artifact whenever there is one and nothing is
  // selected yet. With the dropdown selector always visible (single and
  // multi-artifact cases), this avoids a blank preview pane on mount —
  // the user can still change the selection via the <select>.
  useEffect(() => {
    if (artifacts.length > 0 && selected === null) {
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
        if (err instanceof Error && err.name === "AbortError") return;
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
    <div className="task-detail__body artifacts-pane">
      <header className="artifacts-pane__header">
        <label className="artifacts-pane__selector-label">
          <span className="visually-hidden">Artifact</span>
          <select
            className="artifacts-pane__selector"
            value={selected ?? ""}
            onChange={(e) => handleSelect(e.target.value)}
            aria-label="Select artifact"
          >
            {artifacts.map((a) => (
              <option key={a.url} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <a
          href={selected ? taskArtifactUrl(task.id, selected) : "#"}
          className={`artifacts-pane__download${selected ? "" : " artifacts-pane__download--disabled"}`}
          target="_blank"
          rel="noreferrer noopener"
          download={selected ?? undefined}
          aria-disabled={selected ? undefined : true}
          tabIndex={selected ? undefined : -1}
          title={selected ? `Download ${selected}` : "No artifact selected"}
        >
          Download
        </a>
      </header>
      <div className="artifacts-pane__preview">
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
    // Transient: the auto-select-first effect runs on mount, so this
    // branch is only visible for one frame. Render the spinner copy
    // instead of "Select an artifact" to avoid a confusing flash.
    return <div className="artifact-viewer artifact-viewer--empty">Loading…</div>;
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
    // artifacts. Keying on the filename is sufficient: changing files
    // implies a different viewer kind in practice.
    return (
      <FileViewer
        key={selected}
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
