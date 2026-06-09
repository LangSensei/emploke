import type { WorkflowDagWire, WorkflowHeaderWire, WorkflowNodeWire } from "../../api";
import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";

export interface WorkflowMetaStatsProps {
  workflow: WorkflowHeaderWire;
  /**
   * DAG snapshot for the active workflow. `null` while still being
   * fetched — the Phases stat is omitted in that case (matches the
   * "omit when not yet known" pattern the `Ended` stat already uses).
   * The Phases stat is also omitted when the DAG has zero nodes —
   * see the JSDoc on {@link WorkflowMetaStats} for the rationale.
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
 * "Phases" renders the workflow's progress as `current / total`,
 * 1-indexed for display so the first phase of a 3-phase DAG reads as
 * `1 / 3` (matching the "step X of Y" / "page X of Y" convention used
 * elsewhere in the dashboard). Internally the active-phase index is
 * 0-indexed everywhere — only the display string carries the `+ 1`.
 *
 * `current` is the lowest phase that still has work to do (any
 * `not_started` / `ready` / `running` node), or the last phase value
 * once every node is terminal. `total` is the count of distinct
 * phases in the DAG (max phase value + 1). The fully-completed case
 * therefore renders as `total / total` (e.g. `3 / 3`), which a user
 * correctly reads as "all phases done" — contrast with the earlier
 * single-number rendering that showed `max(phase) + 1 = 3` for both
 * "currently executing phase 0 of 3" and "completed all 3 phases".
 *
 * The Phases stat is omitted entirely while the DAG is still loading
 * (`dag === null`) and ALSO while the DAG has zero nodes — the latter
 * happens in the brief window between workflow creation and the
 * coordinator extending the DAG, when a `0 / 0` rendering would be
 * meaningless to the user. This matches the dashboard's broader
 * "omit when not yet known" pattern (e.g. the `Ended` stat is omitted
 * while a workflow is still running).
 *
 * The `current` value is derived client-side from the DAG snapshot
 * already in hand. A future change could promote it to a substrate-
 * computed `currentPhase` field on the workflow header wire — but
 * for now the substrate has no concept of "current phase", and
 * computing it on the wire would either double-compute (per-workflow
 * read already has the DAG) or force an N+1 fan-out across the list
 * route (matching the existing reason `iterationCount` is optional
 * on list rows).
 */
export function WorkflowMetaStats({ workflow, dag }: WorkflowMetaStatsProps) {
  const createdTitle = formatAbsolute(workflow.createdAt);
  const endedTitle = workflow.endedAt !== undefined ? formatAbsolute(workflow.endedAt) : null;
  const durationLabel = formatDuration(workflow.createdAt, workflow.endedAt ?? null);
  const phaseProgress = dag === null ? null : computePhaseProgress(dag.nodes);

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
      {phaseProgress !== null ? (
        <span
          title="Current execution phase / total phases in the DAG"
          data-testid="workflow-meta-phases"
        >
          <span className="task-detail__statbar-key">Phases</span> {phaseProgress.current + 1} /{" "}
          {phaseProgress.total}
        </span>
      ) : null}
    </>
  );
}

/**
 * Active-phase set the DAG considers "still has work to do". Any node
 * in one of these statuses keeps its `phase` value eligible to be the
 * workflow's `current` phase.
 */
const ACTIVE_NODE_STATUSES = new Set(["not_started", "ready", "running"]);

interface PhaseProgress {
  /** Current execution phase value (raw `phase` integer, 0-indexed). */
  readonly current: number;
  /** Total number of phases in the DAG (max phase value + 1). */
  readonly total: number;
}

/**
 * Derive the workflow's `current / total` phase progress from the DAG
 * nodes. Pure: returns `null` for an empty DAG (the caller treats this
 * the same way it treats `dag === null` and omits the stat entirely —
 * matches the dashboard's "omit when not yet known / not yet
 * populated" pattern, e.g. the `Ended` stat is omitted while a
 * workflow is still running and the whole Phases stat is omitted
 * while the DAG snapshot is still being fetched). For non-empty
 * DAGs, `current` is the lowest phase value among nodes whose status
 * is in {@link ACTIVE_NODE_STATUSES} (0-indexed); if every node is
 * terminal, falls back to the highest phase value seen (so a fully-
 * completed 3-phase workflow returns `current = 2`, which the caller
 * renders 1-indexed as `3 / 3`).
 */
function computePhaseProgress(nodes: readonly WorkflowNodeWire[]): PhaseProgress | null {
  if (nodes.length === 0) return null;
  let maxPhase = -1;
  let minActivePhase = Number.POSITIVE_INFINITY;
  for (const n of nodes) {
    if (n.phase > maxPhase) maxPhase = n.phase;
    if (ACTIVE_NODE_STATUSES.has(n.status) && n.phase < minActivePhase) {
      minActivePhase = n.phase;
    }
  }
  const total = maxPhase + 1;
  const current = Number.isFinite(minActivePhase) ? minActivePhase : maxPhase;
  return { current, total };
}
