import { useMemo } from "react";
import type { WorkflowDagWire, WorkflowNodeWire } from "../../api";

export interface WorkflowDagViewProps {
  dag: WorkflowDagWire;
}

/**
 * Phase-column DAG view. The engine model is "wake the next
 * coordinator after a worker terminates", which means every workflow
 * naturally lays out as a left-to-right sequence of phase columns. We
 * lean on that: nodes are grouped by `phase`, each phase is one
 * column, columns flow left-to-right. Within a phase, nodes are
 * stacked top-to-bottom in `createdAt` ASC order.
 *
 * Edges are intentionally NOT drawn for v1 — the phase ordering makes
 * the flow legible without overlays. A later iteration can layer SVG
 * arrows on top by measuring node bounding rects via refs.
 *
 * Each node is a tooltip-bearing `<div>` (`title` carries the
 * pretty-printed spec) so designer / debugging users can hover to
 * inspect the underlying `spec` object without leaving the page.
 */
export function WorkflowDagView({ dag }: WorkflowDagViewProps) {
  const phases = useMemo(() => groupByPhase(dag.nodes), [dag.nodes]);

  if (dag.nodes.length === 0) {
    return (
      <div className="workflow-dag workflow-dag--empty" data-testid="workflow-dag-empty">
        <div className="empty">
          <div className="empty__icon" aria-hidden="true">
            🪄
          </div>
          <p className="empty__title">No nodes yet</p>
          <p className="empty__hint">
            The coordinator has not proposed any task or follow-up nodes for this workflow.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ul className="workflow-dag" data-testid="workflow-dag" aria-label="Workflow DAG by phase">
      {phases.map(({ phase, nodes }) => (
        <li
          key={phase}
          className="workflow-dag__phase"
          aria-label={`Phase ${phase}`}
          data-phase={phase}
          data-testid={`workflow-dag-phase-${phase}`}
        >
          <div className="workflow-dag__phase-header muted">Phase {phase}</div>
          <div className="workflow-dag__phase-nodes">
            {nodes.map((node) => {
              const kind = nodeKind(node);
              return (
                <div
                  key={node.id}
                  className={`dag-node dag-node--${kind} dag-node--${node.status}`}
                  data-node-id={node.id}
                  data-testid={`dag-node-${node.id}`}
                  title={JSON.stringify(node.spec, null, 2)}
                >
                  <span className="dag-node__kind-icon" aria-hidden="true">
                    {kind === "coordinator" ? "🧠" : "⚙"}
                  </span>
                  <span className="dag-node__id">{node.id.slice(0, 8)}</span>
                  <span className="dag-node__agent">{extractAgent(node)}</span>
                  <span className={`dag-node__status dag-node__status--${node.status}`}>
                    {node.status}
                  </span>
                </div>
              );
            })}
          </div>
        </li>
      ))}
    </ul>
  );
}

interface PhaseGroup {
  readonly phase: number;
  readonly nodes: readonly WorkflowNodeWire[];
}

function groupByPhase(nodes: readonly WorkflowNodeWire[]): readonly PhaseGroup[] {
  const byPhase = new Map<number, WorkflowNodeWire[]>();
  for (const node of nodes) {
    const slot = byPhase.get(node.phase);
    if (slot === undefined) byPhase.set(node.phase, [node]);
    else slot.push(node);
  }
  for (const arr of byPhase.values()) {
    arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return Array.from(byPhase.keys())
    .sort((a, b) => a - b)
    .map((phase) => ({
      phase,
      nodes: byPhase.get(phase) ?? [],
    }));
}

/**
 * Best-effort agent extraction from a node spec. Coordinator and task
 * specs both carry an `agent` field; unknown spec kinds fall back to
 * "—" so the row still renders a placeholder rather than an empty
 * span (visual stability).
 */
function extractAgent(node: WorkflowNodeWire): string {
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

/**
 * Project the node spec's discriminator down to the dashboard's
 * styling vocabulary. The contracts wire shape carries kind ONLY on
 * `spec.kind` (the substrate's opaque envelope is flattened by the
 * server-side projection); unknown / future kinds fall back to
 * `"task"` so the visual still renders a recognisable node.
 */
function nodeKind(node: WorkflowNodeWire): "coordinator" | "task" {
  return node.spec.kind === "coordinator" ? "coordinator" : "task";
}
