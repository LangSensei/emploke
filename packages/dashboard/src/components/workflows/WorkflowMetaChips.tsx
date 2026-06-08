import type { WorkflowDagWire, WorkflowHeaderWire } from "../../api";
import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";

export interface WorkflowMetaChipsProps {
  workflow: WorkflowHeaderWire;
  /**
   * DAG snapshot for the active workflow. `null` while still being
   * fetched — the Phases chip is omitted in that case (matches the
   * "omit when not yet known" pattern the `Ended` chip already uses).
   */
  dag: WorkflowDagWire | null;
}

/**
 * Compact horizontal meta-chip row for the workflow header:
 * `Created · Ended · Duration · Phases`.
 *
 * The coordinator agent moved out of the chip row in v2.3 — it lives
 * in the header `meta-row` alongside the status badge (mirroring the
 * Tasks header pattern of `status + agent-chip`), so duplicating it
 * here would be redundant.
 *
 * "Phases" is derived from the DAG's max `phase + 1` — the real
 * structural depth of the workflow, replacing the v2.1 `iterationCount`
 * chip (a noisy "coord wake count" that varies per coordinator
 * strategy and so couldn't be compared between workflows).
 *
 * One chip per fact so the row wraps gracefully on narrow viewports
 * (each `<dt>/<dd>` pair is one visual chip; the dl list semantics
 * give screen readers a clear "term → value" pairing).
 */
export function WorkflowMetaChips({ workflow, dag }: WorkflowMetaChipsProps) {
  const createdLabel = formatRelative(workflow.createdAt);
  const createdTitle = formatAbsolute(workflow.createdAt);
  const endedLabel = workflow.endedAt !== undefined ? formatRelative(workflow.endedAt) : null;
  const endedTitle = workflow.endedAt !== undefined ? formatAbsolute(workflow.endedAt) : null;
  const durationLabel = formatDuration(workflow.createdAt, workflow.endedAt ?? null);
  const phaseCount = dag === null ? null : computePhaseCount(dag);

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
      {phaseCount !== null ? (
        <div className="workflow-meta-chips__chip">
          <dt>Phases</dt>
          <dd
            title={
              phaseCount === 1
                ? "1 DAG phase (max(node.phase) + 1)"
                : `${phaseCount} DAG phases (max(node.phase) + 1)`
            }
          >
            {phaseCount}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function computePhaseCount(dag: WorkflowDagWire): number {
  if (dag.nodes.length === 0) return 0;
  let max = -1;
  for (const n of dag.nodes) {
    if (n.phase > max) max = n.phase;
  }
  return max + 1;
}
