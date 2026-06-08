import type { WorkflowHeaderWire } from "../../api";
import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";

export interface WorkflowMetaChipsProps {
  workflow: WorkflowHeaderWire;
}

/**
 * Compact horizontal meta-chip row for the workflow header:
 * `Created · Ended · Duration · Coordinator · Iterations`.
 *
 * One chip per fact so the row wraps gracefully on narrow viewports
 * (each `<dt>/<dd>` pair is one visual chip; the dl list semantics
 * give screen readers a clear "term → value" pairing).
 */
export function WorkflowMetaChips({ workflow }: WorkflowMetaChipsProps) {
  const createdLabel = formatRelative(workflow.createdAt);
  const createdTitle = formatAbsolute(workflow.createdAt);
  const endedLabel = workflow.endedAt !== undefined ? formatRelative(workflow.endedAt) : null;
  const endedTitle = workflow.endedAt !== undefined ? formatAbsolute(workflow.endedAt) : null;
  const durationLabel = formatDuration(workflow.createdAt, workflow.endedAt ?? null);

  return (
    <dl className="workflow-meta-chips" data-testid="workflow-meta-chips">
      <div className="workflow-meta-chips__chip">
        <dt>Created</dt>
        <dd title={createdTitle}>{createdLabel}</dd>
      </div>
      {endedLabel !== null ? (
        <div className="workflow-meta-chips__chip">
          <dt>Ended</dt>
          <dd title={endedTitle ?? undefined}>{endedLabel}</dd>
        </div>
      ) : null}
      <div className="workflow-meta-chips__chip">
        <dt>Duration</dt>
        <dd>{durationLabel}</dd>
      </div>
      <div className="workflow-meta-chips__chip">
        <dt>Coordinator</dt>
        <dd title={`Coordinator agent: ${workflow.coordinatorAgent}`}>
          {workflow.coordinatorAgent}
        </dd>
      </div>
      <div className="workflow-meta-chips__chip">
        <dt>Iterations</dt>
        <dd>{workflow.iterationCount}</dd>
      </div>
    </dl>
  );
}
