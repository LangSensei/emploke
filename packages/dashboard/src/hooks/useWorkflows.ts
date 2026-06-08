import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listWorkflows, type WorkflowHeaderWire, type WorkflowListQuery } from "../api";
import {
  ALL_STATUS,
  type StatusFilter,
  sortByCreatedDesc,
  WORKFLOW_POLL_INTERVAL_MS,
} from "../components/workflows/shared";
import { useMounted } from "./useMounted";

export interface UseWorkflowsOpts {
  currentWorkspaceId: string | null;
  statusFilter: StatusFilter;
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
 * (`hooks/useTasks.ts`) without the runtime / time-range filters
 * since the workflow listing only filters by status.
 *
 * Polls every {@link WORKFLOW_POLL_INTERVAL_MS}ms while there is at
 * least one running workflow visible — stops as soon as everything is
 * terminal. The cleanup function on the polling effect clears the
 * interval so the page doesn't leak intervals across tab switches.
 */
export function useWorkflows({
  currentWorkspaceId,
  statusFilter,
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
      const opts: WorkflowListQuery = statusFilter !== ALL_STATUS ? { status: statusFilter } : {};
      const next = await listWorkflows(opts);
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
  }, [currentWorkspaceId, statusFilter]);

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
