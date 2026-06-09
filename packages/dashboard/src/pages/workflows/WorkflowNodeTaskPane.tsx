import { type ReactNode, useCallback, useMemo } from "react";
import type { WorkflowDagWire, WorkflowHeaderWire, WorkflowNodeWire } from "../../api";
import { TaskView } from "../../components/task-view";
import { useTaskDetail } from "../../hooks/useTaskDetail";

export interface WorkflowNodeTaskPaneProps {
  /** The parent workflow header (used for the back-label only). */
  workflow: WorkflowHeaderWire;
  /** The current DAG (used for the prev/next walk). */
  dag: WorkflowDagWire | null;
  /** The task id requested via `?nodeTaskId=`. May be stale (URL-shareable). */
  nodeTaskId: string;
  /** Polling cadence for the task header + activity stream. */
  pollIntervalMs: number;
  /** Called when the user clicks ← Back; parent clears `?nodeTaskId=`. */
  onBack: () => void;
  /** Called when the user clicks ‹ / ›; parent atomically sets `?nodeTaskId=`. */
  onNavigate: (nextTaskId: string) => void;
}

/**
 * Workflows-page Mode B (right pane) — full TaskView for a single
 * workflow node's underlying task. Mirrors the structural shape of
 * {@link FireTaskDetailPane}:
 *
 *   - The pane owns its own node-list walk (sourced from the parent's
 *     already-fetched `dag.nodes`); navigation never re-fetches.
 *   - When `nodeTaskId` resolves to a node in the current dag, the
 *     full `TaskView` is mounted with a header-trailing pill carrying
 *     `← Back to "{brief}"` + `‹ N/M ›`. The N/M counter is keyed off
 *     **node order** (phase ASC, createdAt ASC), so a user walking
 *     `‹` from the start of the workflow sees the next earlier node
 *     in execution order.
 *   - When `nodeTaskId` is not in the current dag (URL shared from
 *     another workflow, or a node was pruned), a "Node not found"
 *     fallback with a back-only row is shown.
 *
 * `useTaskDetail` is mounted via the inner `NodeTaskView` so it can be
 * `key`-remounted on `nodeTaskId` swap — defence-in-depth against any
 * future refactor that breaks the hook's monotonic seq guard.
 */
export function WorkflowNodeTaskPane({
  workflow,
  dag,
  nodeTaskId,
  pollIntervalMs,
  onBack,
  onNavigate,
}: WorkflowNodeTaskPaneProps) {
  const orderedNodes = useMemo(() => orderNodesForNav(dag), [dag]);
  const currentIndex = useMemo(
    () => orderedNodes.findIndex((n) => n.taskId === nodeTaskId),
    [orderedNodes, nodeTaskId],
  );
  const found = currentIndex !== -1;

  const prevId =
    found && currentIndex > 0 ? (orderedNodes[currentIndex - 1]?.taskId ?? null) : null;
  const nextId =
    found && currentIndex < orderedNodes.length - 1
      ? (orderedNodes[currentIndex + 1]?.taskId ?? null)
      : null;

  if (dag === null) {
    return (
      <aside className="tasks-pane__detail" data-testid="workflow-node-pane">
        <FallbackBackRow workflow={workflow} onBack={onBack} />
        <p className="muted" style={{ padding: 16 }}>
          Loading workflow nodes…
        </p>
      </aside>
    );
  }

  if (!found) {
    return (
      <aside className="tasks-pane__detail" data-testid="workflow-node-not-found">
        <FallbackBackRow workflow={workflow} onBack={onBack} />
        <div className="empty" style={{ padding: 16 }}>
          <p className="empty__title">Node not found</p>
          <p className="empty__hint">
            This task is not part of the current workflow's DAG (the node may have been pruned, or
            the URL belongs to a different workflow).
          </p>
        </div>
      </aside>
    );
  }

  const total = orderedNodes.length;
  const position = currentIndex + 1;

  const pill = (
    <WorkflowNodeNav
      workflowBrief={workflow.brief}
      position={position}
      total={total}
      onBack={onBack}
      onPrev={prevId !== null ? () => onNavigate(prevId) : null}
      onNext={nextId !== null ? () => onNavigate(nextId) : null}
    />
  );

  return (
    <aside className="tasks-pane__detail" data-testid="workflow-node-pane">
      <NodeTaskView
        key={nodeTaskId}
        nodeTaskId={nodeTaskId}
        pollIntervalMs={pollIntervalMs}
        headerTrailing={pill}
      />
    </aside>
  );
}

/**
 * Project the DAG into a flat, navigation-ordered node list. Only
 * nodes with a `taskId` are kept (a node without a dispatched task
 * has nothing to show in the right pane). Ordering matches the
 * Graph tab's visual top-to-bottom order:
 *
 *   1. phase ASC (earlier phases first)
 *   2. createdAt ASC (within a phase, the node inserted earliest is
 *      walked first — mirrors `groupByPhase` / `buildSlotMap`).
 */
function orderNodesForNav(dag: WorkflowDagWire | null): WorkflowNodeWire[] {
  if (dag === null) return [];
  return dag.nodes
    .filter((n): n is WorkflowNodeWire & { taskId: string } => n.taskId !== undefined)
    .sort((a, b) => {
      if (a.phase !== b.phase) return a.phase - b.phase;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
}

interface FallbackBackRowProps {
  workflow: WorkflowHeaderWire;
  onBack: () => void;
}

/**
 * Minimal back-only row used while the dag is loading or the
 * requested `nodeTaskId` isn't part of the current workflow. The
 * success path uses {@link WorkflowNodeNav} inside the TaskView
 * title row instead, costing zero extra vertical space.
 */
function FallbackBackRow({ workflow, onBack }: FallbackBackRowProps) {
  return (
    <nav
      className="workflow-node-nav workflow-node-nav--fallback"
      aria-label="Workflow node navigation"
      data-testid="workflow-node-nav"
    >
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={onBack}
        data-testid="workflow-node-back"
        title={`Back to ${workflow.brief}`}
      >
        ← Back to workflow
      </button>
    </nav>
  );
}

interface WorkflowNodeNavProps {
  workflowBrief: string;
  position: number;
  total: number;
  onBack: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}

/**
 * Compact navigation pill rendered in the TaskView title row's trailing
 * slot. Shape: `[← workflow] · [‹ N/M ›]`. Mirrors {@link FireNavPill}
 * structurally so the dashboard's master/detail panes share a
 * recognisable shape.
 *
 * `aria-label="position N of total M"` matches the `FireNavPill`
 * choice — no `aria-live` so the count change as the DAG grows in the
 * background doesn't trigger noisy announcements.
 */
function WorkflowNodeNav({
  workflowBrief,
  position,
  total,
  onBack,
  onPrev,
  onNext,
}: WorkflowNodeNavProps) {
  return (
    <nav
      className="workflow-node-nav"
      aria-label="Workflow node navigation"
      data-testid="workflow-node-nav"
    >
      <button
        type="button"
        className="workflow-node-nav__back"
        onClick={onBack}
        data-testid="workflow-node-back"
        title={`Back to ${workflowBrief}`}
      >
        <span aria-hidden="true">← </span>
        <span className="workflow-node-nav__back-label">workflow</span>
      </button>
      <span className="workflow-node-nav__sep" aria-hidden="true" />
      <button
        type="button"
        className="workflow-node-nav__step"
        onClick={onPrev ?? undefined}
        disabled={onPrev === null}
        data-testid="workflow-node-prev"
        aria-label={`Previous node (currently ${position} of ${total})`}
        title="Previous node"
      >
        ‹
      </button>
      <span className="workflow-node-nav__pos" data-testid="workflow-node-position">
        {position} / {total}
      </span>
      <button
        type="button"
        className="workflow-node-nav__step"
        onClick={onNext ?? undefined}
        disabled={onNext === null}
        data-testid="workflow-node-next"
        aria-label={`Next node (currently ${position} of ${total})`}
        title="Next node"
      >
        ›
      </button>
    </nav>
  );
}

interface NodeTaskViewProps {
  nodeTaskId: string;
  pollIntervalMs: number;
  headerTrailing?: ReactNode;
}

/**
 * Inner remount-keyed view that owns the `useTaskDetail` hook. Same
 * pattern as `FireTaskView` so a future refactor only has to look in
 * one place.
 */
function NodeTaskView({ nodeTaskId, pollIntervalMs, headerTrailing }: NodeTaskViewProps) {
  const { task, activity, activityError, loadOlder } = useTaskDetail(nodeTaskId, pollIntervalMs);
  const handleLoadOlder = useCallback(() => loadOlder(), [loadOlder]);
  return (
    <TaskView
      task={task}
      requestedTaskId={nodeTaskId}
      activity={activity}
      activityError={activityError}
      onLoadOlder={handleLoadOlder}
      headerTrailing={headerTrailing}
    />
  );
}
