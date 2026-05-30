import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ActivityItem,
  fetchTaskActivity,
  getTask,
  subscribeTaskActivity,
  type TaskActivity,
  type TaskRecord,
} from "../api";
import { usePollWithBackoff } from "./usePollWithBackoff";

export interface TaskDetailData {
  task: TaskRecord | null;
  activity: TaskActivity | null;
  activityError: string | null;
  refresh: () => Promise<void>;
  loadOlder: () => Promise<void>;
}

/**
 * Per-task detail data: fetches `getTask` + `fetchTaskActivity`,
 * keeps them fresh while the task is running via {@link usePollWithBackoff}
 * + an SSE tail subscription, and merges paginated activity pages.
 *
 * Extracted verbatim from the original 2377-line `pages/Tasks.tsx`
 * during the mission-A redesign so the detail panel can stay a thin
 * presentational component.
 */
export function useTaskDetail(taskId: string | null, pollIntervalMs: number): TaskDetailData {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [activity, setActivity] = useState<TaskActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const taskTokenRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  // Monotonic request id — incremented on every refresh() call. The
  // current value is captured at call time and re-checked before each
  // setState so a slow response from a previous task swap cannot
  // overwrite the latest task's state. Fixes the rapid-task-switch
  // race where the original `inFlightRef` early-return blocked the
  // new task's fetch while the old response still passed token check.
  const requestSeqRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const activityRef = useRef<TaskActivity | null>(null);
  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    // Coalesce overlapping polls FOR THE SAME TASK, but always allow a
    // task switch to start a fresh request — the seq check below drops
    // any stale response that comes back from the prior task.
    if (inFlightRef.current && taskTokenRef.current === taskId) return;
    const seq = ++requestSeqRef.current;
    const token = taskId;
    taskTokenRef.current = token;
    inFlightRef.current = true;
    try {
      const known = activityRef.current;
      const lastSeq =
        known !== null && known.activity.length > 0
          ? known.activity[known.activity.length - 1]?.seq
          : undefined;
      await Promise.all([
        getTask(taskId).then((t) => {
          if (!mountedRef.current || seq !== requestSeqRef.current) return;
          setTask(t);
        }),
        fetchTaskActivity(taskId, lastSeq !== undefined ? { after: lastSeq } : { limit: 50 })
          .then((a) => {
            if (!mountedRef.current || seq !== requestSeqRef.current) return;
            if (a === null) {
              setActivity(null);
              setActivityError(null);
              return;
            }
            if (lastSeq === undefined) {
              setActivity(a);
            } else {
              setActivity((prev) => mergeForward(prev, a));
            }
            setActivityError(null);
          })
          .catch((e) => {
            if (!mountedRef.current || seq !== requestSeqRef.current) return;
            setActivityError((e as Error).message);
          }),
      ]);
    } catch (e) {
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      setTask(null);
      setActivityError((e as Error).message);
    } finally {
      // Only clear inFlight if WE are still the latest request; a newer
      // task switch may have already started another fetch that owns
      // the flag now.
      if (seq === requestSeqRef.current) inFlightRef.current = false;
    }
  }, [taskId]);

  const loadOlder = useCallback(async (): Promise<void> => {
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
      setActivity((prev) => mergePrev(prev, next));
    } catch (e) {
      if (!mountedRef.current) return;
      setActivityError((e as Error).message);
    } finally {
      loadingOlderRef.current = false;
    }
  }, [taskId]);

  // Reset all per-task state on a task switch (synchronously zero
  // refs so the next `refresh()` doesn't fire `?after=N` against
  // the new task).
  useEffect(() => {
    setTask(null);
    setActivity(null);
    activityRef.current = null;
    setActivityError(null);
    if (!taskId) return;
    void refresh();
  }, [taskId, refresh]);

  // Auto-poll while running.
  const pollEnabled = !!task && task.status === "running";
  usePollWithBackoff(refresh, pollIntervalMs, pollEnabled);

  // Live tail via SSE while running.
  useEffect(() => {
    if (!taskId || !pollEnabled) return;
    const handle = subscribeTaskActivity(taskId, {
      onItem: (item) => {
        if (!mountedRef.current) return;
        setActivity((prev) => mergeStreamItem(prev, item));
      },
      onError: (err) => {
        if (typeof console !== "undefined") {
          console.warn("activity stream error", err);
        }
      },
    });
    return () => handle.close();
  }, [taskId, pollEnabled]);

  return { task, activity, activityError, refresh, loadOlder };
}

function mergeForward(prev: TaskActivity | null, next: TaskActivity): TaskActivity {
  if (prev === null) return next;
  const bySeq = new Map<number, ActivityItem>();
  for (const it of prev.activity) bySeq.set(it.seq, it);
  for (const it of next.activity) bySeq.set(it.seq, it);
  const merged = Array.from(bySeq.values()).sort((x, y) => x.seq - y.seq);
  return {
    activity: merged,
    result: next.result ?? prev.result,
    totalItems: next.totalItems ?? prev.totalItems,
    ...(next.truncated !== undefined ? { truncated: next.truncated } : {}),
  };
}

function mergePrev(prev: TaskActivity | null, next: TaskActivity): TaskActivity {
  if (prev === null) return next;
  const bySeq = new Map<number, ActivityItem>();
  for (const it of next.activity) bySeq.set(it.seq, it);
  for (const it of prev.activity) bySeq.set(it.seq, it);
  const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  return {
    activity: merged,
    result: prev.result ?? next.result,
    totalItems: next.totalItems ?? prev.totalItems,
    ...(prev.truncated !== undefined ? { truncated: prev.truncated } : {}),
  };
}

function mergeStreamItem(prev: TaskActivity | null, item: ActivityItem): TaskActivity {
  const bySeq = new Map<number, ActivityItem>();
  if (prev !== null) {
    for (const it of prev.activity) bySeq.set(it.seq, it);
  }
  bySeq.set(item.seq, item);
  const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  if (prev !== null) {
    return {
      ...prev,
      activity: merged,
      totalItems: Math.max(prev.totalItems, item.seq + 1),
    };
  }
  return {
    activity: merged,
    result: null,
    totalItems: item.seq + 1,
  };
}
