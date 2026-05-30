import { useTaskDetail } from "../../hooks/useTaskDetail";
import { TaskView } from "../task-view";

export interface TaskDetailProps {
  taskId: string;
  pollIntervalMs: number;
}

/**
 * Right-column task detail panel for the master-detail Tasks page.
 *
 * Smart-container responsibilities only: drive per-task data loading
 * via {@link useTaskDetail} (poll + SSE + paginated activity merge)
 * and wrap the dumb {@link TaskView} in the Tasks-page layout
 * container (`.tasks-pane__detail`).
 *
 * All rendering (header, tabs, body) lives in `TaskView`, which is
 * also consumed by the Schedules page's `FireTaskDetailPane` (Mode B
 * of the schedule master-detail; added in a follow-up PR).
 */
export function TaskDetail({ taskId, pollIntervalMs }: TaskDetailProps) {
  const { task, activity, activityError, loadOlder } = useTaskDetail(taskId, pollIntervalMs);

  return (
    <aside className="tasks-pane__detail">
      <TaskView
        task={task}
        requestedTaskId={taskId}
        activity={activity}
        activityError={activityError}
        onLoadOlder={loadOlder}
      />
    </aside>
  );
}
