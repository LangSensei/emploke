import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listScheduledTasks, type TaskRecord } from "../../api";
import { useTaskDetail } from "../../hooks/useTaskDetail";
import { TaskView } from "../task-view";

export interface FireTaskDetailPaneProps {
  /** Schedule whose recent-fires list owns the navigation set. */
  scheduleId: string;
  /** Display name for the "← Back to {name}" link in the Mode B nav row. */
  scheduleName: string;
  /** Task id requested via `?fireTaskId=`. May be stale (aged out of top-10). */
  fireTaskId: string;
  /** Per-task auto-poll interval (passed through to {@link useTaskDetail}). */
  pollIntervalMs: number;
  /** Called when the user clicks ← Back; parent clears `?fireTaskId=`. */
  onBack: () => void;
  /** Called when the user clicks ‹prev / next›; parent atomically sets `?fireTaskId=`. */
  onNavigate: (nextTaskId: string) => void;
}

const MAX_ROWS = 10;

/**
 * Schedules-page Mode B (right pane) — shows the full task detail for a
 * single recent fire of the current schedule. Owns its own
 * {@link listScheduledTasks} fetch keyed by `scheduleId` so the prev /
 * next navigation can walk the same in-memory list the user just clicked
 * from, with no coupling to the Tasks page smart layer.
 *
 * Ownership-gated `useTaskDetail`: the inner {@link FireTaskView} only
 * mounts once `fireTaskId` is confirmed to be in this schedule's recent
 * fires. A stale URL pointing at an arbitrary workspace task therefore
 * cannot leak a `getTask` against it. When the fire isn't in the list
 * (e.g. it aged out of the top-10) a "Fire not found" notice with a
 * Back button is shown instead.
 *
 * The inner view is keyed on `fireTaskId` — every task switch remounts
 * the {@link useTaskDetail} hook. This is now defence-in-depth (the
 * hook is race-safe via its monotonic request id), but cheap and
 * worth keeping to guarantee a clean React tree on every fire swap.
 *
 * Layout contract: returns a single `.tasks-pane__detail` aside (mirrors
 * the standalone `TaskDetail` smart container) so the Schedules-page
 * 2-column grid keeps its existing scroll / flex semantics.
 */
export function FireTaskDetailPane({
  scheduleId,
  scheduleName,
  fireTaskId,
  pollIntervalMs,
  onBack,
  onNavigate,
}: FireTaskDetailPaneProps) {
  const [rows, setRows] = useState<TaskRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    let localCancelled = false;
    setRows(null);
    setError(null);
    listScheduledTasks({ scheduleId })
      .then((next) => {
        if (localCancelled || cancelledRef.current) return;
        next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRows(next.slice(0, MAX_ROWS));
      })
      .catch((e) => {
        if (localCancelled || cancelledRef.current) return;
        setError((e as Error).message);
        setRows([]);
      });
    return () => {
      localCancelled = true;
    };
  }, [scheduleId]);

  const confirmedIndex = useMemo(() => {
    if (rows === null) return -1;
    return rows.findIndex((r) => r.id === fireTaskId);
  }, [rows, fireTaskId]);

  const confirmed = confirmedIndex !== -1;
  const prevId =
    confirmed && confirmedIndex < (rows?.length ?? 0) - 1
      ? (rows![confirmedIndex + 1]?.id ?? null)
      : null;
  const nextId = confirmed && confirmedIndex > 0 ? (rows![confirmedIndex - 1]?.id ?? null) : null;

  if (rows === null) {
    return (
      <aside className="tasks-pane__detail">
        <ModeBNav scheduleName={scheduleName} onBack={onBack} onPrev={null} onNext={null} />
        <p className="muted" style={{ padding: 16 }}>
          Loading…
        </p>
      </aside>
    );
  }

  if (error) {
    return (
      <aside className="tasks-pane__detail">
        <ModeBNav scheduleName={scheduleName} onBack={onBack} onPrev={null} onNext={null} />
        <div className="alert alert--error" style={{ margin: 16 }}>
          ⚠️ {error}
        </div>
      </aside>
    );
  }

  if (!confirmed) {
    return (
      <aside className="tasks-pane__detail" data-testid="fire-task-not-found">
        <ModeBNav scheduleName={scheduleName} onBack={onBack} onPrev={null} onNext={null} />
        <div className="empty" style={{ padding: 16 }}>
          <p className="empty__title">Fire not found</p>
          <p className="empty__hint">
            This fire is not in this schedule's recent fires (it may have aged out of the top{" "}
            {MAX_ROWS}).
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="tasks-pane__detail">
      <ModeBNav
        scheduleName={scheduleName}
        onBack={onBack}
        onPrev={prevId ? () => onNavigate(prevId) : null}
        onNext={nextId ? () => onNavigate(nextId) : null}
      />
      <FireTaskView key={fireTaskId} fireTaskId={fireTaskId} pollIntervalMs={pollIntervalMs} />
    </aside>
  );
}

interface ModeBNavProps {
  scheduleName: string;
  onBack: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}

/**
 * Mode B navigation row. Inline styles only (no new global CSS) so the
 * Schedules page stays self-contained for the schedule-UI overhaul PR.
 *
 * Layout note: deliberately uses a unique `fire-task-nav` class (NOT
 * `task-detail__head`) so the `.tasks-pane__detail > .task-detail__head`
 * flex rule applies only to the inner TaskView header. Two elements
 * with that class would both receive `flex: 0 0 auto`, breaking the
 * head-pinned / body-scrolls master-detail layout.
 *
 * The previous "Open in Tasks ↗" escape-hatch link was removed: this
 * pane already renders the full task surface (TaskHeaderCard + activity
 * timeline + artifacts + output) via {@link FireTaskView}, so deep-
 * linking to the Tasks page would only navigate the user away from
 * richer context to identical content. The ← Back button remains the
 * sole exit point.
 */
function ModeBNav({ scheduleName, onBack, onPrev, onNext }: ModeBNavProps) {
  return (
    <nav
      className="fire-task-nav"
      aria-label="Fire task navigation"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexDirection: "row",
        flexWrap: "wrap",
        padding: "8px 12px",
        borderBottom: "1px solid var(--color-border)",
        flex: "0 0 auto",
      }}
      data-testid="fire-task-nav"
    >
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={onBack}
        data-testid="fire-task-back"
        title={`Back to ${scheduleName}`}
      >
        ← Back to {scheduleName}
      </button>
      <div style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onPrev ?? undefined}
          disabled={onPrev === null}
          data-testid="fire-task-prev"
          aria-label="Previous fire"
          title="Previous fire (older)"
        >
          ‹ prev
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onNext ?? undefined}
          disabled={onNext === null}
          data-testid="fire-task-next"
          aria-label="Next fire"
          title="Next fire (newer)"
        >
          next ›
        </button>
      </div>
    </nav>
  );
}

interface FireTaskViewProps {
  fireTaskId: string;
  pollIntervalMs: number;
}

/**
 * Inner remount-keyed view that owns the `useTaskDetail` hook. The
 * hook is now race-safe on its own (monotonic `requestSeqRef` drops
 * stale responses), so the `key={fireTaskId}` remount from the parent
 * is defence-in-depth: it guarantees a clean React tree on every task
 * switch even if some future refactor reintroduces a closure-captured
 * stale state in the hook.
 */
function FireTaskView({ fireTaskId, pollIntervalMs }: FireTaskViewProps) {
  const { task, activity, activityError, loadOlder } = useTaskDetail(fireTaskId, pollIntervalMs);
  const handleLoadOlder = useCallback(() => loadOlder(), [loadOlder]);
  return (
    <TaskView
      task={task}
      requestedTaskId={fireTaskId}
      activity={activity}
      activityError={activityError}
      onLoadOlder={handleLoadOlder}
    />
  );
}
