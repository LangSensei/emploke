import { PlusIcon, RefreshIcon } from "../Icons";

export interface TasksToolbarProps {
  dispatchDisabled: boolean;
  dispatchDisabledTitle: string;
  onDispatch: () => void;
}

/**
 * Page-top action strip for the Tasks view: Dispatch task.
 * Extracted from `pages/Tasks.tsx` so the shell stays under its
 * 300-line budget.
 *
 * Iter-2 F1: the page already auto-polls every `pollIntervalMs`
 * (default 4s) and now also refreshes on `visibilitychange`. A
 * manual Refresh button signalled "the page is stale" which is
 * false; Linear / GitHub Actions / Vercel-style live dashboards
 * don't have one either. Dispatch is the only page-top action.
 */
export function TasksToolbar({
  dispatchDisabled,
  dispatchDisabledTitle,
  onDispatch,
}: TasksToolbarProps) {
  return (
    <button
      type="button"
      className="btn btn--primary"
      onClick={onDispatch}
      disabled={dispatchDisabled}
      title={dispatchDisabledTitle}
    >
      <PlusIcon />
      <span>Dispatch task</span>
    </button>
  );
}

export interface TasksEmptyStateProps {
  loading?: boolean;
  title?: string;
  hint?: string;
}

/**
 * Loading / empty / no-match panel for the task list. `loading=true`
 * renders the spinner variant; otherwise the supplied title + hint
 * are shown.
 */
export function TasksEmptyState({ loading, title, hint }: TasksEmptyStateProps) {
  if (loading) {
    return (
      <div className="empty">
        <div className="empty__icon spin" aria-hidden="true">
          <RefreshIcon />
        </div>
        <p className="empty__title">Loading tasks…</p>
      </div>
    );
  }
  return (
    <div className="empty">
      <div className="empty__icon">📝</div>
      <p className="empty__title">{title}</p>
      {hint && <p className="empty__hint">{hint}</p>}
    </div>
  );
}

export interface TaskDetailPlaceholderProps {
  /** Workspace has zero tasks at all (filters not the cause). */
  zeroTasks: boolean;
}

/**
 * Calm centered placeholder rendered in the right column when no task
 * is selected (the visible list is empty). Sibling to {@link TasksEmptyState}
 * so the two pieces share styling but live in distinct DOM positions:
 * one inside `.tasks-pane__list`, this one inside `.tasks-pane__detail`.
 */
export function TaskDetailPlaceholder({ zeroTasks }: TaskDetailPlaceholderProps) {
  return (
    <aside className="tasks-pane__detail tasks-pane__detail--empty">
      <div className="empty">
        <div className="empty__icon">📝</div>
        <p className="empty__title">No task selected</p>
        <p className="empty__hint">
          {zeroTasks ? "Dispatch a task to get started" : "No tasks match the current filters"}
        </p>
      </div>
    </aside>
  );
}
