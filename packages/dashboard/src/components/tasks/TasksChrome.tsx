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

/**
 * Calm centered placeholder rendered in the right column when no task
 * is selected (the visible list is empty). Sibling to {@link TasksEmptyState}
 * so the two pieces share styling but live in distinct DOM positions:
 * one inside `.tasks-pane__list`, this one inside `.tasks-pane__detail`.
 *
 * PR #189 polish v7 (#194) — the legacy `zeroTasks` prop was removed.
 * Since v4 the workspace-empty case is handled by {@link TasksZeroState}
 * upstream and the `visibleTasks.length === 0` early return in
 * `TasksPage` short-circuits before this placeholder ever mounts, so
 * the `zeroTasks ? … : …` ternary was unreachable. The remaining
 * "filtered-to-zero but visible rows present" branch is the only one
 * that ever rendered, so the copy is hard-coded.
 */
export function TaskDetailPlaceholder() {
  return (
    <aside className="tasks-pane__detail tasks-pane__detail--empty">
      <div className="empty">
        <div className="empty__icon">📝</div>
        <p className="empty__title">No task selected</p>
        <p className="empty__hint">No tasks match the current filters</p>
      </div>
    </aside>
  );
}

export interface TasksZeroStateProps {
  dispatchDisabled: boolean;
  dispatchDisabledTitle: string;
  onDispatch: () => void;
}

/**
 * Full-width single-pane zero-state rendered when the workspace has no
 * tasks at all (PR #189 polish v3 — collapses the double empty-state
 * surfaced by the list + detail-placeholder pair). Sits inside a
 * `.tasks-pane--zero` grid container so it spans the whole row. The
 * Dispatch-task CTA opens the page's own modal in place — no nav.
 */
export function TasksZeroState({
  dispatchDisabled,
  dispatchDisabledTitle,
  onDispatch,
}: TasksZeroStateProps) {
  return (
    <div className="empty tasks-pane__zero" data-testid="tasks-empty-zero">
      <div className="empty__icon" aria-hidden="true">
        📝
      </div>
      <p className="empty__title">No tasks yet</p>
      <p className="empty__hint">
        Dispatch a task to run an agent autonomously and read the result here when it finishes.
      </p>
      <button
        type="button"
        className="btn btn--primary"
        onClick={onDispatch}
        disabled={dispatchDisabled}
        title={dispatchDisabledTitle}
        data-testid="tasks-empty-zero-cta"
      >
        <PlusIcon />
        <span>Dispatch task</span>
      </button>
    </div>
  );
}
