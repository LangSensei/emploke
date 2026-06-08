import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listWorkflows, type WorkflowHeaderWire, type WorkflowListQuery } from "../api";
import { ALL_AGENTS, presetToSinceMs, type TimePreset } from "../components/tasks/shared";
import { sortByCreatedDesc, WORKFLOW_POLL_INTERVAL_MS } from "../components/workflows/shared";
import { useMounted } from "./useMounted";

export interface UseWorkflowsOpts {
  currentWorkspaceId: string | null;
  /** Substring search on the workflow id; empty string = no filter. */
  idQuery: string;
  /** Coordinator-agent FQN; `ALL_AGENTS` sentinel = no filter. */
  agentFilter: string;
  /** Time-range preset; `"all"` = no `createdSince` lower bound. */
  timeFilter: TimePreset;
}

export interface UseWorkflowsResult {
  workflows: readonly WorkflowHeaderWire[];
  loaded: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
}

/**
 * Page-level data layer for the Workflows list. Mirrors `useTasks`
 * (`hooks/useTasks.ts`) — three URL-driven filter slots are
 * translated into a single `WorkflowListQuery` and forwarded to the
 * server. The server's `?q=` / `?coordinatorAgent=` / `?createdSince=`
 * slots AND-combine; absent slots widen the result set.
 *
 * Polls every {@link WORKFLOW_POLL_INTERVAL_MS}ms while there is at
 * least one running workflow visible — stops as soon as everything is
 * terminal. The cleanup function on the polling effect clears the
 * interval so the page doesn't leak intervals across tab switches.
 */
export function useWorkflows({
  currentWorkspaceId,
  idQuery,
  agentFilter,
  timeFilter,
}: UseWorkflowsOpts): UseWorkflowsResult {
  const [workflows, setWorkflows] = useState<readonly WorkflowHeaderWire[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useMounted();
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!currentWorkspaceId) {
      setWorkflows([]);
      setLoaded(true);
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const opts: { q?: string; coordinatorAgent?: string; createdSince?: string } = {};
      if (idQuery !== "") opts.q = idQuery;
      if (agentFilter !== ALL_AGENTS) opts.coordinatorAgent = agentFilter;
      const sinceMs = presetToSinceMs(timeFilter);
      if (sinceMs !== null) opts.createdSince = new Date(sinceMs).toISOString();
      const next = await listWorkflows(opts as WorkflowListQuery);
      if (!mounted.current) return;
      setWorkflows(sortByCreatedDesc(next));
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlightRef.current = false;
      if (mounted.current) setLoaded(true);
    }
  }, [currentWorkspaceId, idQuery, agentFilter, timeFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const anyRunning = useMemo(() => workflows.some((w) => w.status === "running"), [workflows]);

  useEffect(() => {
    if (!currentWorkspaceId) return;
    if (!anyRunning) return;
    const handle = setInterval(() => {
      void refresh();
    }, WORKFLOW_POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [anyRunning, currentWorkspaceId, refresh]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  return { workflows, loaded, error, setError, refresh };
}
