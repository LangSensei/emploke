import type { WorkflowHeaderWire } from "../../api";
import { WORKFLOW_STATUS_LABEL, workflowStatusTone } from "./shared";

export interface WorkflowStatusBadgeProps {
  status: WorkflowHeaderWire["status"];
}

/**
 * Status badge for a workflow row or detail header. Mirrors the
 * Schedules / Tasks status-badge shape (`badge--with-dot`); the dot
 * pulses while the workflow is running and stops once the workflow
 * reaches a terminal status. The `aria-live="polite"` announcement
 * lets assistive tech read the status flip without stealing focus.
 *
 * See components/tasks/StatusBadge.tsx for the parallel pattern that
 * established the `.badge--with-dot` + pulse class wiring.
 */
export function WorkflowStatusBadge({ status }: WorkflowStatusBadgeProps) {
  const tone = workflowStatusTone(status);
  const pulse = status === "running";
  return (
    <span
      className={`badge badge--${tone} badge--with-dot`}
      role="status"
      aria-live="polite"
      data-testid={`workflow-status-badge-${status}`}
    >
      <span className={`badge__dot${pulse ? " badge__dot--pulse" : ""}`} aria-hidden="true" />
      {WORKFLOW_STATUS_LABEL[status]}
    </span>
  );
}
