import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WorkflowDagWire, WorkflowNodeWire } from "../../api";
import {
  buildSlotMap,
  type EdgeEndpoints,
  groupByPhase,
  projectEndpoints,
  type Rect,
  resolveEdges,
} from "./dagEdgeGeometry";

export interface WorkflowDagViewProps {
  dag: WorkflowDagWire;
  /** Optional node selection (drives the `aria-current="true"` + `.dag-node--selected` styling). */
  selectedNodeId?: string | null;
  /**
   * Called when the user activates (click / Enter / Space) a node.
   * Receives the full wire-shape node so the caller can branch on
   * `taskId` presence without re-looking up the dag map. When the
   * caller is presentational only and doesn't need a click handler,
   * the prop can be omitted — the nodes still render but become
   * non-interactive `<div>`s.
   */
  onSelectNode?: (node: WorkflowNodeWire) => void;
}

/**
 * Vertical (top-to-bottom) DAG view per the v2.1 spec. One row per
 * `phase`, multiple columns per phase for sibling nodes (sorted by
 * `createdAt` ASC within the phase). An SVG overlay draws straight
 * arrows from each parent node's bottom-centre to its child's
 * top-centre, measured at render time via `getBoundingClientRect`.
 *
 * Each node is a `<button>` (when `onSelectNode` is provided) so it
 * is keyboard-reachable, can carry `aria-current`, and triggers
 * navigation on Enter / Space without extra `onKeyDown` plumbing.
 * The visual chip is unchanged across the button / div fork.
 */
export function WorkflowDagView({ dag, selectedNodeId, onSelectNode }: WorkflowDagViewProps) {
  const phases = useMemo(() => groupByPhase(dag.nodes), [dag.nodes]);
  const slotMap = useMemo(() => buildSlotMap(phases), [phases]);
  const segments = useMemo(() => resolveEdges(dag.edges, slotMap), [dag.edges, slotMap]);

  const containerRef = useRef<HTMLElement | null>(null);
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map());
  const setNodeRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el === null) nodeRefs.current.delete(id);
      else nodeRefs.current.set(id, el);
    },
    [],
  );

  const [endpoints, setEndpoints] = useState<readonly EdgeEndpoints[]>([]);
  const [overlay, setOverlay] = useState<{ width: number; height: number } | null>(null);

  const recompute = useCallback(() => {
    const container = containerRef.current;
    if (container === null) return;
    const containerRect = container.getBoundingClientRect();
    const rects = new Map<string, Rect>();
    for (const [id, el] of nodeRefs.current.entries()) {
      const r = el.getBoundingClientRect();
      rects.set(id, {
        left: r.left - containerRect.left,
        top: r.top - containerRect.top,
        width: r.width,
        height: r.height,
      });
    }
    setOverlay({ width: containerRect.width, height: containerRect.height });
    setEndpoints(projectEndpoints(segments, rects));
  }, [segments]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `dag.nodes.length`/`dag.edges.length` are intentional re-render triggers — `recompute` reads node refs and the segments memo, neither of which closes over the dag length, so adding them as deps forces a remeasure after the DAG grows.
  useLayoutEffect(() => {
    recompute();
  }, [recompute, dag.nodes.length, dag.edges.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `dag.nodes.length` triggers re-observation of newly-added node refs; otherwise the ResizeObserver only watches the set of refs captured at first mount.
  useEffect(() => {
    if (containerRef.current === null) return;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", recompute);
      return () => window.removeEventListener("resize", recompute);
    }
    const obs = new ResizeObserver(() => recompute());
    obs.observe(containerRef.current);
    for (const el of nodeRefs.current.values()) {
      obs.observe(el);
    }
    return () => obs.disconnect();
  }, [recompute, dag.nodes.length]);

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
    <section
      ref={containerRef}
      className="workflow-dag workflow-dag--vertical"
      data-testid="workflow-dag"
      aria-label="Workflow DAG (top-to-bottom by phase)"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: `.workflow-dag` sets `overflow: auto`; axe-core's `scrollable-region-focusable` rule (Level A, serious) requires the container to be keyboard-focusable so users without a mouse can pan the overflow. The `aria-label` already gives it an accessible name.
      tabIndex={0}
    >
      {overlay !== null ? (
        <svg
          className="workflow-dag__edges"
          width={overlay.width}
          height={overlay.height}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="workflow-dag-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="workflow-dag__arrow-head" />
            </marker>
          </defs>
          {endpoints.map((e) => (
            <line
              key={e.id}
              className="workflow-dag__edge"
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              markerEnd="url(#workflow-dag-arrow)"
            />
          ))}
        </svg>
      ) : null}

      <ul className="workflow-dag__phases">
        {phases.map(({ phase, nodes }) => (
          <li
            key={phase}
            className="workflow-dag__phase"
            aria-label={`Phase ${phase}`}
            data-phase={phase}
            data-testid={`workflow-dag-phase-${phase}`}
          >
            <div className="workflow-dag__phase-label muted" aria-hidden="true">
              Phase {phase}
            </div>
            <div className="workflow-dag__phase-row">
              {nodes.map((node) => {
                const kind = nodeKind(node);
                const isSelected = selectedNodeId !== undefined && selectedNodeId === node.id;
                const className = [
                  "dag-node",
                  `dag-node--${kind}`,
                  `dag-node--${node.status}`,
                  isSelected ? "dag-node--selected" : null,
                ]
                  .filter((s) => s !== null)
                  .join(" ");
                const title = JSON.stringify(node.spec, null, 2);
                // Trim trailing dashes from the 8-char short id so the chip
                // never ends on a separator if a future id format ever
                // produces one (matches the defense in ArtifactsTab's
                // node group label). UUIDv4 first-8 is pure hex so this
                // is a no-op today, kept as belt-and-braces.
                const idShort = node.id.slice(0, 8).replace(/-+$/, "");
                const agent = extractAgent(node);
                const inner = (
                  <>
                    <span className="dag-node__kind-icon" aria-hidden="true">
                      {kind === "coordinator" ? "🧠" : "⚙"}
                    </span>
                    <span className="dag-node__id">{idShort}</span>
                    <span className="dag-node__agent">{agent}</span>
                    <span className={`dag-node__status dag-node__status--${node.status}`}>
                      {node.status}
                    </span>
                  </>
                );
                if (onSelectNode === undefined) {
                  return (
                    <div
                      key={node.id}
                      ref={setNodeRef(node.id)}
                      className={className}
                      data-node-id={node.id}
                      data-testid={`dag-node-${node.id}`}
                      title={title}
                    >
                      {inner}
                    </div>
                  );
                }
                const interactive = node.taskId !== undefined;
                return (
                  <button
                    key={node.id}
                    ref={setNodeRef(node.id)}
                    type="button"
                    className={className}
                    data-node-id={node.id}
                    data-testid={`dag-node-${node.id}`}
                    title={interactive ? `Open task ${node.taskId}` : title}
                    aria-current={isSelected ? "true" : undefined}
                    aria-disabled={interactive ? undefined : true}
                    onClick={() => {
                      if (!interactive) return;
                      onSelectNode(node);
                    }}
                  >
                    {inner}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Best-effort agent extraction from a node spec. Coordinator and worker
 * specs both carry an `agent` field; unknown spec kinds fall back to
 * "—" so the row still renders a placeholder rather than an empty
 * span (visual stability).
 */
function extractAgent(node: WorkflowNodeWire): string {
  const spec = node.spec;
  if (
    (spec.kind === "coordinator" || spec.kind === "worker") &&
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
 * `"worker"` so the visual still renders a recognisable node.
 */
function nodeKind(node: WorkflowNodeWire): "coordinator" | "worker" {
  return node.spec.kind === "coordinator" ? "coordinator" : "worker";
}
