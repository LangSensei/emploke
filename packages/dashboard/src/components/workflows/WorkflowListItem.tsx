import type { WorkflowHeaderWire } from "../../api";
import { formatAbsolute, formatRelative } from "../../utils/time";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";

export interface WorkflowListItemProps {
  workflow: WorkflowHeaderWire;
  selected: boolean;
  onSelect: () => void;
  /** 1-based position within the visible list (for `aria-posinset`). */
  posinset: number;
  /** Total visible rows (for `aria-setsize`). */
  setsize: number;
}

/**
 * One row of the workflow list. Selection is a real `<button>` so the
 * keyboard contract is unambiguous; the `<li>` itself carries the
 * `aria-posinset` / `aria-setsize` cues that Safari + VoiceOver need
 * to announce row position. Mirrors the structural shape of
 * `components/schedules/ScheduleListItem.tsx` (status badge + headline
 * + meta line) minus the per-row action menu — workflow row actions
 * (cancel) live on the detail pane only because cancel is the single
 * mutation v1 exposes and gating it through the detail's "are you
 * sure" modal keeps the destructive affordance off the list.
 *
 * Row meta line carries: id (short) · coordinator agent · iteration
 * count · "Started X" relative time. Created/ended deltas are
 * tooltip-only — the list stays scan-friendly.
 */
export function WorkflowListItem({
  workflow,
  selected,
  onSelect,
  posinset,
  setsize,
}: WorkflowListItemProps) {
  const shortId = workflow.id.slice(0, 8);
  const startedLabel = formatRelative(workflow.createdAt);
  const startedTitle = formatAbsolute(workflow.createdAt);
  return (
    <li
      className={`task-list__item${selected ? " task-list__item--selected" : ""}${
        workflow.status === "running" ? " task-list__item--running" : ""
      }`}
      data-testid={`workflow-row-${workflow.id}`}
      aria-posinset={posinset}
      aria-setsize={setsize}
    >
      <button
        type="button"
        className="task-list__item-select"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="task-list__item-head">
          <WorkflowStatusBadge status={workflow.status} />
        </span>
        <span
          className="task-list__item-headline task-list__item-headline--clamp"
          title={workflow.brief}
        >
          {workflow.brief}
        </span>
        <span className="task-list__item-meta muted">
          <code className="task-list__id" title={`Workflow id: ${workflow.id}`}>
            {shortId}
          </code>
          <span className="task-list__sep">·</span>
          <span title={`Coordinator: ${workflow.coordinatorAgent}`}>
            {workflow.coordinatorAgent}
          </span>
          <span className="task-list__sep">·</span>
          <span title={`Iteration count: ${workflow.iterationCount}`}>
            iter {workflow.iterationCount}
          </span>
          <span className="task-list__sep">·</span>
          <span className="muted" title={startedTitle}>
            Started {startedLabel}
          </span>
        </span>
      </button>
    </li>
  );
}
