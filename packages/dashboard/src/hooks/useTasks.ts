import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listRuntimes, listTasks, type TaskRecord } from "../api";
import {
  ALL_AGENTS,
  ALL_RUNTIMES,
  presetToSinceMs,
  type TimePreset,
} from "../components/tasks/shared";
import { useMounted } from "./useMounted";
import { usePollWithBackoff } from "./usePollWithBackoff";
import { errorMessage } from "../utils/errors";

export interface UseTasksOpts {
  currentWorkspaceId: string | null;
  pollIntervalMs: number;
  /**
   * Filter values flow in as opts — TasksPage owns them (URL-driven
   * via `useUrlSearchValue`, Phase 1.5 Block G). The hook just runs
   * the network fetch + polling cadence against whatever values the
   * caller hands it; that way refresh / back-button / share-link all
   * keep working without a parallel "internal state" layer to keep
   * in sync.
   */
  agentFilter: string;
  runtimeFilter: string;
  timeFilter: TimePreset;
}

export interface UseTasksResult {
  tasks: TaskRecord[];
  runtimes: string[];
  loaded: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
}

/**
 * Page-level data layer for the Tasks list view: fetches the task
 * list (with server-side filters), the runtime catalog, and keeps
 * the list fresh via {@link usePollWithBackoff} while anything is
 * still running.
 *
 * Phase 1.5 Block G — filter state lifted out of this hook to the
 * page so it can be backed by the URL. The hook is now purely a
 * data-fetcher; it does not own filter state.
 */
export function useTasks({
  currentWorkspaceId,
  pollIntervalMs,
  agentFilter,
  runtimeFilter,
  timeFilter,
}: UseTasksOpts): UseTasksResult {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mounted = useMounted();

  const wsTokenRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!currentWorkspaceId) {
      setTasks([]);
      setLoaded(true);
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const token = currentWorkspaceId;
    wsTokenRef.current = token;
    try {
      const sinceMs = presetToSinceMs(timeFilter);
      const opts: Parameters<typeof listTasks>[0] = {};
      if (agentFilter !== ALL_AGENTS) opts.agent = agentFilter;
      if (runtimeFilter !== ALL_RUNTIMES) opts.runtime = runtimeFilter;
      if (sinceMs !== null) opts.createdSince = new Date(sinceMs).toISOString();
      const next = await listTasks(opts);
      if (!mounted.current) return;
      if (token !== currentWorkspaceId) return;
      setError(null);
      next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setTasks(next);
    } catch (e) {
      if (!mounted.current) return;
      if (token !== currentWorkspaceId) return;
      setError(errorMessage(e));
    } finally {
      inFlightRef.current = false;
      if (mounted.current && token === currentWorkspaceId) {
        setLoaded(true);
      }
    }
  }, [currentWorkspaceId, agentFilter, runtimeFilter, timeFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    listRuntimes()
      .then((rts) => {
        if (!cancelled) setRuntimes(rts.map((r) => r.kind));
      })
      .catch(() => {
        /* non-fatal: the runtime dropdown stays disabled */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const anyRunning = useMemo(() => tasks.some((t) => t.status === "running"), [tasks]);
  usePollWithBackoff(refresh, pollIntervalMs, anyRunning && !!currentWorkspaceId);

  // Iter-2 F1: refresh immediately when the tab becomes visible again
  // after being hidden, so users coming back to a tab after hours
  // don't see stale data while they wait for the next poll tick.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  return {
    tasks,
    runtimes,
    loaded,
    error,
    setError,
    refresh,
  };
}
