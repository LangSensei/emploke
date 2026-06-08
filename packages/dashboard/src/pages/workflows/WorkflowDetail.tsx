import type { WorkflowDagWire, WorkflowHeaderWire } from "../../api";
import { WorkflowStatusBadge } from "../../components/workflows/WorkflowStatusBadge";
import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";
import { WorkflowDagView } from "./WorkflowDagView";

export interface WorkflowDetailProps {
  workflow: WorkflowHeaderWire;
  dag: WorkflowDagWire | null;
  dagError: string | null;
  /** Bumped by the parent on Cancel success so the detail can re-render the new status banner. */
  cancelBusy: boolean;
  onCancel: () => void;
}

/**
 * Right-pane detail view for a single workflow. Mirrors the structural
 * shape of `components/schedules/ScheduleDetail.tsx`:
 *
 *   - Header: identity (status badge + brief + short id), temporal facts
 *     (Created / Ended / Duration), coordinator agent, iteration count,
 *     and the Cancel CTA when still running.
 *   - Body: optional `details` block + the {@link WorkflowDagView}.
 *
 * Polling for the workflow header and DAG is owned by the parent page
 * via `useWorkflowDetail` — this component is presentational only.
 */
export function WorkflowDetail({
  workflow,
  dag,
  dagError,
  cancelBusy,
  onCancel,
}: WorkflowDetailProps) {
  const createdLabel = formatRelative(workflow.createdAt);
  const createdTitle = formatAbsolute(workflow.createdAt);
  const endedLabel = workflow.endedAt ? formatRelative(workflow.endedAt) : null;
  const endedTitle = workflow.endedAt ? formatAbsolute(workflow.endedAt) : null;
  const durationLabel = formatDuration(workflow.createdAt, workflow.endedAt ?? null);
  const canCancel = workflow.status === "running";

  return (
    <aside className="tasks-pane__detail workflow-detail" data-testid="workflow-detail">
      <header className="workflow-detail__header">
        <div className="workflow-detail__header-row">
          <WorkflowStatusBadge status={workflow.status} />
          <h2 className="workflow-detail__title" title={workflow.brief}>
            {workflow.brief}
          </h2>
        </div>
        <div className="workflow-detail__meta muted">
          <code
            className="task-list__id"
            title={`Workflow id: ${workflow.id}`}
            data-testid="workflow-detail-id"
          >
            {workflow.id}
          </code>
          <span className="task-list__sep">·</span>
          <span title={`Coordinator agent: ${workflow.coordinatorAgent}`}>
            {workflow.coordinatorAgent}
          </span>
          <span className="task-list__sep">·</span>
          <span title={`Iteration count: ${workflow.iterationCount}`}>
            iter {workflow.iterationCount}
          </span>
        </div>
        <div className="workflow-detail__facts">
          <div data-testid="workflow-detail-created">
            <span className="muted">Created </span>
            <span title={createdTitle}>{createdLabel}</span>
          </div>
          {endedLabel !== null ? (
            <div data-testid="workflow-detail-ended">
              <span className="muted">Ended </span>
              <span title={endedTitle ?? undefined}>{endedLabel}</span>
            </div>
          ) : null}
          <div data-testid="workflow-detail-duration">
            <span className="muted">Duration </span>
            <span>{durationLabel}</span>
          </div>
        </div>
        {workflow.status === "failed" || workflow.status === "cancelled" ? (
          <div
            className="alert alert--info"
            style={{ marginTop: 8 }}
            data-testid="workflow-detail-outcome"
          >
            <strong>Outcome:</strong> Reason unavailable — substrate gap tracked in #334.
          </div>
        ) : null}
        {canCancel ? (
          <div className="workflow-detail__actions">
            <button
              type="button"
              className="btn btn--danger"
              onClick={onCancel}
              disabled={cancelBusy}
              data-testid="workflow-detail-cancel"
            >
              {cancelBusy ? "Cancelling…" : "Cancel workflow"}
            </button>
          </div>
        ) : null}
      </header>

      {workflow.details !== undefined && workflow.details !== "" ? (
        <section className="workflow-detail__details">
          <h3>Details</h3>
          <pre className="workflow-detail__details-body" data-testid="workflow-detail-details">
            {workflow.details}
          </pre>
        </section>
      ) : null}

      <section className="workflow-detail__dag">
        <h3>DAG</h3>
        {dagError !== null ? (
          <div className="alert alert--error" data-testid="workflow-dag-error">
            ⚠️ {dagError}
          </div>
        ) : dag === null ? (
          <div className="empty" data-testid="workflow-dag-loading">
            <p className="empty__title">Loading DAG…</p>
          </div>
        ) : (
          <WorkflowDagView dag={dag} />
        )}
      </section>
    </aside>
  );
}
