import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listRuntimes, listTasks, type TaskRecord } from "../api";
import {
  ALL_AGENTS,
  ALL_RUNTIMES,
  presetToSinceMs,
  type TimePreset,
} from "../components/tasks/shared";
import { usePollWithBackoff } from "./usePollWithBackoff";

export interface UseTasksOpts {
  currentWorkspaceId: string | null;
  pollIntervalMs: number;
}

export interface UseTasksResult {
  tasks: TaskRecord[];
  runtimes: string[];
  loaded: boolean;
  refreshing: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  // Filter state.
  agentFilter: string;
  setAgentFilter: (v: string) => void;
  runtimeFilter: string;
  setRuntimeFilter: (v: string) => void;
  timeFilter: TimePreset;
  setTimeFilter: (v: TimePreset) => void;
  idQuery: string;
  setIdQuery: (v: string) => void;
  // Actions.
  refresh: () => Promise<void>;
}

/**
 * Page-level data layer for the Tasks list view: fetches the task
 * list (with server-side filters), the runtime catalog, and keeps
 * the list fresh via {@link usePollWithBackoff} while anything is
 * still running. Extracted from `pages/Tasks.tsx` during the
 * master-detail redesign so the shell page stays under its 300-line
 * budget.
 */
export function useTasks({ currentWorkspaceId, pollIntervalMs }: UseTasksOpts): UseTasksResult {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [agentFilter, setAgentFilter] = useState<string>(ALL_AGENTS);
  const [runtimeFilter, setRuntimeFilter] = useState<string>(ALL_RUNTIMES);
  const [timeFilter, setTimeFilter] = useState<TimePreset>("7d");
  const [idQuery, setIdQuery] = useState("");

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    setRefreshing(true);
    try {
      const sinceMs = presetToSinceMs(timeFilter);
      const opts: Parameters<typeof listTasks>[0] = {};
      if (agentFilter !== ALL_AGENTS) opts.agent = agentFilter;
      if (runtimeFilter !== ALL_RUNTIMES) opts.runtime = runtimeFilter;
      if (sinceMs !== null) opts.createdSince = new Date(sinceMs).toISOString();
      // Phase A: Tasks page is standalone-only. Workflow-origin tasks
      // will surface on a separate (future) page; we never want them
      // mixed into the master list here.
      opts.origin = "standalone";
      const next = await listTasks(opts);
      if (!mountedRef.current) return;
      if (token !== currentWorkspaceId) return;
      setError(null);
      next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setTasks(next);
    } catch (e) {
      if (!mountedRef.current) return;
      if (token !== currentWorkspaceId) return;
      setError((e as Error).message);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && token === currentWorkspaceId) {
        setRefreshing(false);
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

  return {
    tasks,
    runtimes,
    loaded,
    refreshing,
    error,
    setError,
    agentFilter,
    setAgentFilter,
    runtimeFilter,
    setRuntimeFilter,
    timeFilter,
    setTimeFilter,
    idQuery,
    setIdQuery,
    refresh,
  };
}
