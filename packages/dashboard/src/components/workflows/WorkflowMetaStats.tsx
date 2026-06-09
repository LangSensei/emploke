import type { WorkflowDagWire, WorkflowHeaderWire } from "../../api";
import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";

export interface WorkflowMetaStatsProps {
  workflow: WorkflowHeaderWire;
  /**
   * DAG snapshot for the active workflow. `null` while still being
   * fetched — the Phases stat is omitted in that case (matches the
   * "omit when not yet known" pattern the `Ended` stat already uses).
   */
  dag: WorkflowDagWire | null;
}

/**
 * Compact meta-stats segment for the workflow detail header:
 * `Created · Ended · Duration · Phases`.
 *
 * Renders a fragment of `<span>` elements designed to slot into the
 * shared `.task-detail__statbar` flex row alongside Tasks' canonical
 * `Runtime · Started · …` siblings (see `TaskView.tsx` for the
 * parallel). Each stat uses the same `.task-detail__statbar-key`
 * label + value shape so the row reads visually identical to a Tasks
 * detail header, mirroring the v2.3 "reuse `task-*` classes" rule.
 *
 * The coordinator agent moved out of this segment in v2.3 — it lives
 * in the header `meta-row` alongside the status badge (mirroring the
 * Tasks header pattern of `status + agent-chip`), so duplicating it
 * here would be redundant.
 *
 * "Phases" is derived from the DAG's max `phase + 1` — the real
 * structural depth of the workflow, replacing the v2.1 `iterationCount`
 * stat (a noisy "coord wake count" that varies per coordinator
 * strategy and so couldn't be compared between workflows).
 */
export function WorkflowMetaStats({ workflow, dag }: WorkflowMetaStatsProps) {
  const createdTitle = formatAbsolute(workflow.createdAt);
  const endedTitle = workflow.endedAt !== undefined ? formatAbsolute(workflow.endedAt) : null;
  const durationLabel = formatDuration(workflow.createdAt, workflow.endedAt ?? null);
  const phaseCount = dag === null ? null : computePhaseCount(dag);

  return (
    <>
      <span title={createdTitle}>
        <span className="task-detail__statbar-key">Created</span>{" "}
        {formatRelative(workflow.createdAt)}
      </span>
      {workflow.endedAt !== undefined ? (
        <span title={endedTitle ?? undefined}>
          <span className="task-detail__statbar-key">Ended</span> {formatRelative(workflow.endedAt)}
        </span>
      ) : null}
      <span>
        <span className="task-detail__statbar-key">Duration</span> {durationLabel}
      </span>
      {phaseCount !== null ? (
        <span
          title={
            phaseCount === 1
              ? "1 DAG phase (max(node.phase) + 1)"
              : `${phaseCount} DAG phases (max(node.phase) + 1)`
          }
          data-testid="workflow-meta-phases"
        >
          <span className="task-detail__statbar-key">Phases</span> {phaseCount}
        </span>
      ) : null}
    </>
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
