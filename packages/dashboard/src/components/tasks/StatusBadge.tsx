import type { TaskStatus } from "../../api";
import { STATUS_LABEL } from "./shared";

/**
 * Status badge with a leading colored dot. The dot is always rendered
 * and inherits the badge's text color via `currentColor`, so each
 * status (running/succeeded/failure/cancelled/muted) gets its tone
 * automatically. The dot pulses via CSS keyframes only when `pulse`
 * is true (i.e., the task is running); it stops as soon as the task
 * transitions to a terminal status.
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
    <span className={`badge badge--${tone} badge--with-dot`}>
      <span className={`badge__dot${pulse ? " badge__dot--pulse" : ""}`} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}
