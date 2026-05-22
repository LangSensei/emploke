import type { TaskActivity } from "../../../api";
import { ActivityView } from "../ActivityView";
import { StickToBottomScroll } from "../StickToBottomScroll";

export interface LogsTabProps {
  taskId: string;
  activity: TaskActivity | null;
  activityError: string | null;
  onLoadOlder: () => Promise<void>;
}

/**
 * Logs tab — the full live-tailing activity stream. Preserves the
 * stick-to-bottom + load-older-on-scroll-up behaviour of the original
 * Activity tab; only the parent shell is different.
 */
export function LogsTab({ taskId, activity, activityError, onLoadOlder }: LogsTabProps) {
  return (
    <StickToBottomScroll
      className="task-detail__body"
      resetKey={taskId}
      followKey={activity?.activity[activity.activity.length - 1]?.seq ?? 0}
      topAnchorKey={activity?.activity[0]?.seq ?? 0}
    >
      <ActivityView activity={activity} activityError={activityError} onLoadOlder={onLoadOlder} />
    </StickToBottomScroll>
  );
}
