import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowArtifactWire, WorkflowDagWire, WorkflowHeaderWire } from "../../api";
import { workflowArtifactUrl } from "../../api";
import { MarkdownSummary } from "../../components/tasks/TaskDetail/MarkdownSummary";
import { useWorkflowArtifacts } from "../../hooks/useWorkflowArtifacts";

export interface ArtifactsTabProps {
  workflow: WorkflowHeaderWire;
  dag: WorkflowDagWire | null;
}

interface NodeGroup {
  nodeId: string;
  agentLabel: string;
  artifacts: WorkflowArtifactWire[];
}

/**
 * Compose the sentinel sub-path the server's static-bytes route
 * expects. The wire shape's `path` is relative to the underlying
 * artifact root only — the sentinel prefix (`summary/` or
 * `nodes/<nid>/`) is what tells the server which root to look in.
 */
function artifactSubPath(a: WorkflowArtifactWire): string {
  return a.kind === "workflow-summary" ? `summary/${a.path}` : `nodes/${a.nodeId}/${a.path}`;
}

/**
 * Artifacts tab — workflow-level artifact browser.
 *
 * Two visual sections:
 *   1. **Summary** — coordinator-curated artifacts directly under
 *      `<workflowDir>/artifact/`, addressed by `summary/<rest>`.
 *   2. **Per-node** — each entry produced by a dispatched task,
 *      grouped under the originating workflow node, addressed by
 *      `nodes/<nodeId>/<rest>`.
 *
 * Within each section, markdown files render inline via
 * {@link MarkdownSummary}, images via `<img>`, everything else via a
 * download link. The MIME bucket carries the discriminator so the
 * dashboard doesn't need to re-derive it from the extension.
 */
export function ArtifactsTab({ workflow, dag }: ArtifactsTabProps) {
  const isRunning = workflow.status === "running";
  const { artifacts, error, loaded } = useWorkflowArtifacts(workflow.id, isRunning);

  const { summary, nodes } = useMemo(
    () => groupArtifacts(artifacts?.artifacts ?? [], dag),
    [artifacts, dag],
  );

  if (error !== null) {
    return (
      <div className="workflow-artifacts" data-testid="workflow-artifacts-tab">
        <div className="alert alert--error" data-testid="workflow-artifacts-error">
          ⚠️ {error}
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="workflow-artifacts" data-testid="workflow-artifacts-tab">
        <div className="empty" data-testid="workflow-artifacts-loading">
          <p className="empty__title">Loading artifacts…</p>
        </div>
      </div>
    );
  }

  const empty = summary.length === 0 && nodes.length === 0;

  if (empty) {
    return (
      <div className="workflow-artifacts" data-testid="workflow-artifacts-tab">
        <div className="empty" data-testid="workflow-artifacts-empty">
          <div className="empty__icon" aria-hidden="true">
            📂
          </div>
          <p className="empty__title">No artifacts</p>
          <p className="empty__hint">
            Neither the coordinator nor any task has emitted a workflow artifact yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="workflow-artifacts" data-testid="workflow-artifacts-tab">
      {summary.length > 0 ? (
        <section className="workflow-artifacts__section" data-testid="workflow-artifacts-summary">
          <h3 className="workflow-artifacts__h">Summary</h3>
          <ul className="workflow-artifacts__list">
            {summary.map((a) => (
              <li key={a.path} className="workflow-artifacts__item">
                <ArtifactCard workflowId={workflow.id} artifact={a} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {nodes.map((group) => (
        <section
          key={group.nodeId}
          className="workflow-artifacts__section"
          data-testid={`workflow-artifacts-node-${group.nodeId}`}
        >
          <h3 className="workflow-artifacts__h">
            Node{" "}
            <code className="workflow-artifacts__node-id" title={group.nodeId}>
              {group.nodeId.slice(0, 8)}
            </code>{" "}
            <span className="muted">· {group.agentLabel}</span>
          </h3>
          <ul className="workflow-artifacts__list">
            {group.artifacts.map((a) => (
              <li key={a.path} className="workflow-artifacts__item">
                <ArtifactCard workflowId={workflow.id} artifact={a} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface ArtifactCardProps {
  workflowId: string;
  artifact: WorkflowArtifactWire;
}

/**
 * Per-artifact card: inline markdown / image preview for cheap
 * formats, download-link fallback for everything else.
 *
 * For markdown we fetch the body once on mount (small files; spec
 * caps inline preview by mimeBucket alone). For images we lean on
 * `<img>` so the browser handles caching and decoding.
 */
function ArtifactCard({ workflowId, artifact }: ArtifactCardProps) {
  const href = workflowArtifactUrl(workflowId, artifactSubPath(artifact));
  const filename = filenameOf(artifact.path);
  const isMarkdown = artifact.mimeBucket === "text" && /\.md$/i.test(filename);
  const isImage = artifact.mimeBucket === "image";
  return (
    <div className="workflow-artifacts__card" data-mime-bucket={artifact.mimeBucket}>
      <div className="workflow-artifacts__card-header">
        <span className="workflow-artifacts__filename" title={artifact.path}>
          {filename}
        </span>
        <span className="workflow-artifacts__size muted">{formatBytes(artifact.size)}</span>
        <a
          className="workflow-artifacts__download"
          href={href}
          download={filename}
          target="_blank"
          rel="noreferrer noopener"
        >
          Download
        </a>
      </div>
      {isMarkdown ? <MarkdownPreview src={href} /> : null}
      {isImage ? (
        <img src={href} alt={filename} className="workflow-artifacts__image" loading="lazy" />
      ) : null}
    </div>
  );
}

/**
 * Fetch a markdown file on mount and render it inline. Aborts on
 * unmount so a slow response doesn't update an unmounted node; the
 * fallback is a `download` link rendered by the parent so failure is
 * never silent.
 */
function MarkdownPreview({ src }: { src: string }) {
  const [body, setBody] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setBody(null);
    setErr(null);
    (async () => {
      try {
        const res = await fetch(src, { signal: ctrl.signal });
        if (!res.ok) {
          setErr(`Failed to load (${res.status})`);
          return;
        }
        const text = await res.text();
        if (ctrl.signal.aborted) return;
        setBody(text);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => ctrl.abort();
  }, [src]);

  if (err !== null) {
    return <div className="workflow-artifacts__md-error muted">{err}</div>;
  }
  if (body === null) {
    return <div className="workflow-artifacts__md-loading muted">Loading…</div>;
  }
  return (
    <div className="workflow-artifacts__md">
      <MarkdownSummary source={body} />
    </div>
  );
}

function groupArtifacts(
  artifacts: readonly WorkflowArtifactWire[],
  dag: WorkflowDagWire | null,
): { summary: WorkflowArtifactWire[]; nodes: NodeGroup[] } {
  const summary: WorkflowArtifactWire[] = [];
  const byNode = new Map<string, WorkflowArtifactWire[]>();

  for (const a of artifacts) {
    if (a.kind === "workflow-summary") {
      summary.push(a);
      continue;
    }
    const existing = byNode.get(a.nodeId);
    if (existing !== undefined) {
      existing.push(a);
    } else {
      byNode.set(a.nodeId, [a]);
    }
  }

  const nodeOrder = dagNodeOrder(dag);
  const nodes: NodeGroup[] = [];
  const seen = new Set<string>();
  for (const nodeId of nodeOrder) {
    const list = byNode.get(nodeId);
    if (list === undefined) continue;
    seen.add(nodeId);
    nodes.push({
      nodeId,
      agentLabel: agentLabelFor(nodeId, dag),
      artifacts: sortArtifacts(list),
    });
  }
  for (const [nodeId, list] of byNode.entries()) {
    if (seen.has(nodeId)) continue;
    nodes.push({
      nodeId,
      agentLabel: agentLabelFor(nodeId, dag),
      artifacts: sortArtifacts(list),
    });
  }
  return { summary: sortArtifacts(summary), nodes };
}

function dagNodeOrder(dag: WorkflowDagWire | null): string[] {
  if (dag === null) return [];
  return [...dag.nodes]
    .sort((a, b) => {
      if (a.phase !== b.phase) return a.phase - b.phase;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    })
    .map((n) => n.id);
}

function agentLabelFor(nodeId: string, dag: WorkflowDagWire | null): string {
  if (dag === null) return "—";
  const node = dag.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return "—";
  const spec = node.spec;
  if (
    (spec.kind === "coordinator" || spec.kind === "task") &&
    "agent" in spec &&
    typeof spec.agent === "string"
  ) {
    return spec.agent;
  }
  return "—";
}

function sortArtifacts<T extends WorkflowArtifactWire>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.path.localeCompare(b.path));
}

function filenameOf(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
