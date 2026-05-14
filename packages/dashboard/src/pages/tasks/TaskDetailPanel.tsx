import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ActivityItem,
  fetchTaskActivity,
  getTask,
  subscribeTaskActivity,
  type TaskActivity,
  type TaskRecord,
} from "../../api";
import { RefreshIcon } from "../../components/Icons";
import { usePollWithBackoff } from "../../hooks/usePollWithBackoff";
import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";
import { ActivityView } from "./EventsViewer";
import { ResultSection } from "./ResultSection";
import { StatusBadge } from "./StatusBadge";
import { StickToBottomScroll } from "./StickToBottomScroll";
import { STATUS_TONE } from "./status";
import { TaskInstructions } from "./TaskInstructions";

interface TaskDetailPanelProps {
  taskId: string | null;
  onClose: () => void;
  onRerun: (task: TaskRecord) => void;
  /** Auto-refresh cadence while the displayed task is running (ms). */
  pollIntervalMs: number;
}

type DetailTab = "activity" | "raw" | "metadata";

export function TaskDetailPanel({
  taskId,
  onClose,
  onRerun,
  pollIntervalMs,
}: TaskDetailPanelProps) {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [activity, setActivity] = useState<TaskActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("activity");
  const [loading, setLoading] = useState(false);

  // Race guards mirroring the list view (see TasksPage.refresh):
  //   * `mountedRef` for the standard unmount-during-fetch case
  //   * `taskTokenRef` to drop the response when the user clicks task A
  //     then task B before A's two-step fetch (getTask + activity)
  //     completes — without this guard A's payload would land
  //     under B's header
  //   * `inFlightRef` to keep the auto-poll from stacking when a refresh
  //     outlives `pollIntervalMs` (a real risk on the detail panel
  //     because each cycle fires three serial fetches)
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const taskTokenRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const loadingOlderRef = useRef(false);
  // Mirror of the activity state, kept in a ref so callbacks (notably
  // loadOlderActivity, which can fire from IntersectionObserver any
  // time) read the latest seq window without re-creating their closure
  // on every state change. setState updaters are async, so the
  // earlier "snapshot via setState((prev) => prev)" trick raced the
  // first IntersectionObserver fire and bailed early — leaving the
  // sentinel stuck in view, never re-firing because IO only triggers
  // on intersection state CHANGES.
  const activityRef = useRef<TaskActivity | null>(null);

  /**
   * Prepend the previous page of activity items. Called when the user
   * scrolls to the TOP of the timeline (top sentinel intersects).
   * Reads the oldest currently-loaded seq from `activityRef` and asks
   * for the page immediately preceding it.
   *
   * No-ops when there's no older page (oldest seq already 0) or when
   * a page fetch is already in flight. Errors are surfaced via the
   * existing activityError channel.
   *
   * Important: the `StickToBottomScroll` parent ignores prepends (its
   * `followKey` tracks the LAST item's seq, not the count) so the
   * user's reading position is preserved automatically. The scroll
   * anchor compensation (keep the user's viewport content stable
   * after the list grows at the top) lives in the sentinel
   * component below — see `LoadOlderSentinel`.
   */
  const loadOlderActivity = useCallback(async (): Promise<void> => {
    if (!taskId) return;
    if (loadingOlderRef.current) return;
    const a = activityRef.current;
    if (a === null || a.activity.length === 0) return;
    const oldestSeq = a.activity[0]?.seq;
    if (oldestSeq === undefined || oldestSeq <= 0) return;
    loadingOlderRef.current = true;
    try {
      const next = await fetchTaskActivity(taskId, { before: oldestSeq, limit: 50 });
      if (!mountedRef.current) return;
      if (next === null) return;
      setActivity((prev) => {
        if (prev === null) return next;
        // Merge by seq (last-write-wins for any overlap, though there
        // shouldn't be any since the new page is strictly older).
        const bySeq = new Map<number, ActivityItem>();
        for (const it of next.activity) bySeq.set(it.seq, it);
        for (const it of prev.activity) bySeq.set(it.seq, it);
        const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
        return {
          activity: merged,
          // Existing headline result wins (it's from the tail and
          // always newer than anything we'd find by scrolling up).
          result: prev.result ?? next.result,
          // totalItems is authoritative for the WHOLE log, so the
          // server tells us the same value either way; prefer the
          // freshest (might increase between calls if the task is
          // still running).
          totalItems: next.totalItems ?? prev.totalItems,
          // Truncation marker on the prepended page is about the
          // raw-read tail cap, which doesn't apply here — the older
          // page that we successfully fetched is, by definition, not
          // the one that hit the cap. Keep whichever the existing
          // state has.
          ...(prev.truncated !== undefined ? { truncated: prev.truncated } : {}),
        };
      });
    } catch (e) {
      if (!mountedRef.current) return;
      setActivityError((e as Error).message);
    } finally {
      loadingOlderRef.current = false;
    }
  }, [taskId]);

  // Keep the ref synced with the latest activity state so
  // loadOlderActivity can read the current oldest seq without taking
  // `activity` as a dep (which would re-create the callback on every
  // SSE tick and thrash IntersectionObserver).
  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);

  // Tab is plain state — no need for a ref since `refreshDetail` no
  // longer branches on which tab is active (the Raw tab now renders
  // the same `activity` payload as JSON).
  const refreshDetail = useCallback(async () => {
    if (!taskId) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const token = taskId;
    taskTokenRef.current = token;
    setLoading(true);
    try {
      // Always fetch:
      //   - task metadata (cheap; drives status badge, header, result fallback)
      //   - activity timeline tail (small parsed JSON; drives Activity
      //     tab, Result panel, AND the Raw tab — which now just renders
      //     the activity payload as JSON, no separate request needed)
      //
      // On poll re-fetches we use forward-pagination from the
      // currently-known last seq when possible — much cheaper than
      // re-fetching the full tail every cycle. First load always
      // fetches the latest 50 (no `after` set).
      const known = activityRef.current;
      const lastSeq =
        known !== null && known.activity.length > 0
          ? known.activity[known.activity.length - 1]?.seq
          : undefined;
      await Promise.all([
        getTask(taskId).then((t) => {
          if (!mountedRef.current || token !== taskTokenRef.current) return;
          setTask(t);
        }),
        fetchTaskActivity(taskId, lastSeq !== undefined ? { after: lastSeq } : { limit: 50 })
          .then((a) => {
            if (!mountedRef.current || token !== taskTokenRef.current) return;
            if (a === null) {
              setActivity(null);
              setActivityError(null);
              return;
            }
            // Forward fetch: merge into existing state. Initial fetch
            // (`lastSeq === undefined`): replace.
            if (lastSeq === undefined) {
              setActivity(a);
            } else {
              setActivity((prev) => {
                if (prev === null) return a;
                const bySeq = new Map<number, ActivityItem>();
                for (const it of prev.activity) bySeq.set(it.seq, it);
                for (const it of a.activity) bySeq.set(it.seq, it);
                const merged = Array.from(bySeq.values()).sort((x, y) => x.seq - y.seq);
                return {
                  activity: merged,
                  result: a.result ?? prev.result,
                  totalItems: a.totalItems ?? prev.totalItems,
                  ...(a.truncated !== undefined ? { truncated: a.truncated } : {}),
                };
              });
            }
            setActivityError(null);
          })
          .catch((e) => {
            if (!mountedRef.current || token !== taskTokenRef.current) return;
            setActivityError((e as Error).message);
          }),
      ]);
    } catch (e) {
      if (!mountedRef.current || token !== taskTokenRef.current) return;
      setTask(null);
      setActivityError((e as Error).message);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && token === taskTokenRef.current) {
        setLoading(false);
      }
    }
  }, [taskId]);

  useEffect(() => {
    // Always reset the per-task fetched state when the URL switches
    // tasks. Without this, switching from task A to task B leaves A's
    // activity in state and the next render shows A's payload under B's
    // header until the new fetch resolves. The ref must be cleared
    // synchronously so refreshDetail (called below) doesn't see the
    // previous task's last-seq and issue an `?after=N` against the new
    // task — setActivity(null) is async and the syncing useEffect runs
    // a render later.
    setTask(null);
    setActivity(null);
    activityRef.current = null;
    setActivityError(null);
    if (!taskId) return;
    void refreshDetail();
  }, [taskId, refreshDetail]);

  // Auto-poll while running so the runtime's event log + status update
  // without a manual refresh click. Cadence comes from the parent (which
  // sources it from /api/config) so list view and detail view stay in
  // sync. Backoff matches the list-view loop above.
  const detailPollEnabled = !!task && (task.status === "running" || task.status === "not_started");
  usePollWithBackoff(refreshDetail, pollIntervalMs, detailPollEnabled);

  // Live tail via SSE while the task is running. The poll above keeps
  // the task header (status, exit fields) up to date — the SSE stream
  // delivers individual ActivityItems as they're produced, so the
  // timeline updates in near-real-time without burning the polling
  // budget. Items are merged by `seq` (last-write-wins) so a
  // tool_call's "running" -> "success" transition (same seq, updated
  // status) renders correctly. On terminal status the subscription
  // closes itself; we also tear down on task switch / unmount.
  useEffect(() => {
    if (!taskId || !detailPollEnabled) return;
    const handle = subscribeTaskActivity(taskId, {
      onItem: (item) => {
        if (!mountedRef.current) return;
        setActivity((prev) => {
          // Merge by seq; new items append, existing seqs overwrite (handles
          // tool_call begin -> end mutation that yields the same seq twice).
          const bySeq = new Map<number, ActivityItem>();
          if (prev !== null) {
            for (const it of prev.activity) bySeq.set(it.seq, it);
          }
          bySeq.set(item.seq, item);
          const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
          return prev !== null
            ? {
                ...prev,
                activity: merged,
                // Live tail items are by definition extending the
                // total so we update totalItems to stay >= max(seq+1).
                totalItems: Math.max(prev.totalItems, item.seq + 1),
              }
            : {
                activity: merged,
                result: null,
                // Best-effort bootstrap when the very first thing we
                // see is an SSE item (no prior REST snapshot). The next
                // REST poll will replace this with the authoritative
                // server count.
                totalItems: item.seq + 1,
              };
        });
      },
      onError: (err) => {
        // Soft error: the EventSource auto-reconnects; we just log
        // for visibility. A persistent error surfaces via the polling
        // path's activityError state when the next refreshDetail runs.
        if (typeof console !== "undefined") {
          console.warn("activity stream error", err);
        }
      },
    });
    return () => handle.close();
  }, [taskId, detailPollEnabled]);

  // Result is the agent's final answer. Two rules:
  //
  //  1. **Only when actually finished successfully.** Earlier the panel
  //     surfaced `activity.result` (= last assistant message in the log)
  //     unconditionally, so during a running task the most recent
  //     intermediate thought showed up as if it were the headline. We
  //     gate on `status === "success"` so Result only ever reflects a
  //     real completion. Failures route through the dedicated Failure
  //     alert in the header; cancelled / running tasks show no Result
  //     at all.
  //
  //  2. **Truncate long results.** Real Copilot results vary from one
  //     line to ~50 lines. Without a cap a long result would push the
  //     activity timeline below the fold. We default to ~600 chars
  //     ("Show more" reveals the rest); below that threshold the
  //     control is omitted entirely so short results render cleanly.
  //
  // Computed up here so `useState` for the expand toggle stays at the
  // top of the hook order.
  const headlineResult =
    task?.status === "success"
      ? (activity?.result ??
        (typeof task?.result?.output === "string" && task.result.output.length > 0
          ? task.result.output
          : null))
      : null;

  // Common box styling lives in CSS now. The right panel anchors at
  // the top of its grid cell (.tasks-pane__detail), with its own
  // scroll container and a viewport-capped max-height so the page
  // never grows scrollbars regardless of event-log size.
  if (!taskId) {
    return (
      <aside className="tasks-pane__detail tasks-pane__detail--empty">
        <p className="muted" style={{ margin: 0 }}>
          Select a task to view details.
        </p>
      </aside>
    );
  }

  // Pull the runtime exit fields out of metadata where the kernel keeps
  // them. `failure.error` is the human-readable reason; the kernel-level
  // failure type only carries that one field.
  const metadata = (task?.metadata ?? {}) as Record<string, unknown>;
  const exitCode =
    typeof metadata.exitCode === "number" || metadata.exitCode === null
      ? (metadata.exitCode as number | null)
      : undefined;
  const exitSignal = typeof metadata.exitSignal === "string" ? metadata.exitSignal : undefined;
  const runtime = typeof metadata.runtime === "string" ? metadata.runtime : undefined;
  // Runtime-supplied display title (Copilot writes it into
  // `workspace.yaml`'s `name`/`summary`; the runtime adapter folds
  // it into `metadata.title`). It's a curated 5-7 word label sized
  // for headline use, distinct from `instructions` (which can be
  // multi-paragraph). The list item already uses it; mirror the
  // same rule here so the detail page also leads with the
  // human-readable name instead of the opaque task id.
  //
  // No fallback to "first line of instructions": the full
  // instructions render right below this header, so a derived
  // title would just duplicate visible text. Tasks without a
  // runtime title get no `<h2>` row — the layout collapses
  // gracefully to today's id-led header.
  const title =
    typeof metadata.title === "string" && metadata.title.length > 0 ? metadata.title : null;
  const isRunning = task && (task.status === "running" || task.status === "not_started");

  return (
    <aside className="tasks-pane__detail">
      <header className="task-detail__head">
        {title && <h2 className="task-detail__title">{title}</h2>}
        <div className="task-detail__head-row">
          <code className="task-detail__id" title={taskId}>
            {taskId}
          </code>
          {task && (
            <StatusBadge
              status={task.status}
              tone={STATUS_TONE[task.status]}
              pulse={isRunning ?? false}
            />
          )}
          <span className="task-detail__head-spacer" />
          {task && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onRerun(task)}
              title="Re-dispatch with the same agent + instructions"
            >
              Re-run
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={refreshDetail}
            disabled={loading}
            aria-label="Refresh detail"
            title="Refresh"
          >
            <RefreshIcon className={loading ? "spin" : undefined} />
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close detail"
            title="Close"
          >
            ✕
          </button>
        </div>
        {task && (
          <div className="task-detail__statbar">
            <span title={`Agent: ${task.agent}`}>
              <span className="task-detail__statbar-key">Agent</span> {task.agent}
            </span>
            {runtime && (
              <span title={`Runtime: ${runtime}`}>
                <span className="task-detail__statbar-key">Runtime</span> {runtime}
              </span>
            )}
            {task.startedAt && (
              <span title={formatAbsolute(task.startedAt)}>
                <span className="task-detail__statbar-key">Started</span>{" "}
                {formatRelative(task.startedAt)}
              </span>
            )}
            {(task.endedAt || isRunning) && task.startedAt && (
              <span
                title={
                  task.endedAt
                    ? `Ended ${formatAbsolute(task.endedAt)}`
                    : "Running, elapsed up to now"
                }
              >
                <span className="task-detail__statbar-key">
                  {task.endedAt ? "Duration" : "Elapsed"}
                </span>{" "}
                {formatDuration(task.startedAt, task.endedAt ?? null)}
              </span>
            )}
          </div>
        )}
        {task?.instructions && <TaskInstructions text={task.instructions} />}
        {task?.failure && (
          <div className="alert alert--error" style={{ margin: 0 }}>
            <strong>Failure:</strong> {task.failure.error}
            {exitCode !== undefined && exitCode !== null && <> (exit {exitCode})</>}
            {exitSignal && <> [signal {exitSignal}]</>}
          </div>
        )}
      </header>

      {headlineResult !== null && <ResultSection text={headlineResult} />}

      <nav className="pills" style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          className={`pills__btn${tab === "activity" ? " pills__btn--active" : ""}`}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
        <button
          type="button"
          className={`pills__btn${tab === "raw" ? " pills__btn--active" : ""}`}
          onClick={() => setTab("raw")}
          title="Same activity payload as the Activity tab, rendered as raw JSON for debugging"
        >
          Raw JSON
        </button>
        <button
          type="button"
          className={`pills__btn${tab === "metadata" ? " pills__btn--active" : ""}`}
          onClick={() => setTab("metadata")}
        >
          Metadata
        </button>
      </nav>

      {tab === "activity" && (
        <StickToBottomScroll
          className="task-detail__body"
          // Reset on task switch so the new task lands at the bottom.
          resetKey={taskId ?? ""}
          // Follow only when a NEW tail event arrives. Using
          // `length` would also fire on `LoadOlderSentinel` prepends,
          // which would yank the user back to the bottom while
          // they're scrolling up to read history — exactly the
          // anti-pattern we're trying to avoid. The `seq` of the
          // last item is monotonic per task and only changes when
          // the runtime emits a new event.
          followKey={activity?.activity[activity.activity.length - 1]?.seq ?? 0}
          // Top-anchor: when the FIRST item's seq decreases (older
          // history was prepended), preserve the user's reading
          // position by adjusting scrollTop by the prepended block's
          // height. Without this the content under the user's eyes
          // would shift down by exactly the prepended height.
          topAnchorKey={activity?.activity[0]?.seq ?? 0}
        >
          <ActivityView
            activity={activity}
            activityError={activityError}
            onLoadOlder={loadOlderActivity}
          />
        </StickToBottomScroll>
      )}

      {tab === "raw" && (
        <div className="task-detail__body">
          {activity === null && activityError && (
            <p className="muted">
              Activity not available yet
              {activityError ? `: ${activityError}` : ""}.
            </p>
          )}
          {activity === null && !activityError && (
            // 404 NoEventsYet from the server — the runtime hasn't
            // produced any activity yet (common in the first seconds
            // of a task's life, before the agent's first event). The
            // poll-while-running loop will surface activity as it
            // appears.
            <p className="muted">No activity yet for this task.</p>
          )}
          {activity !== null && (
            <pre className="task-detail__events">{JSON.stringify(activity, null, 2)}</pre>
          )}
        </div>
      )}

      {tab === "metadata" && task && (
        <div className="task-detail__body">
          <pre className="task-detail__events">
            {JSON.stringify(
              {
                instructions: task.instructions,
                metadata: task.metadata,
                result: task.result,
                failure: task.failure,
              },
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </aside>
  );
}
