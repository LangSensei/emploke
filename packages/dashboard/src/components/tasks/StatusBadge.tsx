import type { TaskStatus } from "../../api";
import { STATUS_LABEL } from "./shared";

/**
 * Status badge with optional pulsing dot for "running" tasks. The
 * pulse animates via CSS keyframes (.badge__pulse-dot) and stops as
 * soon as the task transitions to a terminal status.
 */
export function StatusBadge({
  status,
  tone,
  pulse,
}: {
  status: TaskStatus;
  tone: string;
  pulse: boolean;
}) {
  return (
    <span className={`badge badge--${tone}${pulse ? " badge--with-pulse" : ""}`}>
      {pulse && <span className="badge__pulse-dot" aria-hidden="true" />}
      {STATUS_LABEL[status]}
    </span>
  );
}
