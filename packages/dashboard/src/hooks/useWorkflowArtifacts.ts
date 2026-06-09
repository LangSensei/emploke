import { useCallback, useEffect, useRef, useState } from "react";
import { listWorkflowArtifacts, type WorkflowArtifactsResponse } from "../api";
import { WORKFLOW_POLL_INTERVAL_MS } from "../components/workflows/shared";
import { useMounted } from "./useMounted";

export interface UseWorkflowArtifactsResult {
  artifacts: WorkflowArtifactsResponse | null;
  error: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

/**
 * Per-workflow artifact list with snap-then-poll semantics:
 *
 *   - One immediate fetch on mount / `workflowId` change so the
 *     Artifacts tab paints as soon as it opens.
 *   - When `isRunning` is true, a {@link WORKFLOW_POLL_INTERVAL_MS}
 *     poll keeps the list fresh while the coordinator is still
 *     curating workflow-summary outputs. Polling stops the moment
 *     the workflow terminates — terminal artifact sets don't change.
 *
 * Stale-response guard: a monotonic `seq` counter incremented on each
 * `refresh()` call gates the `setState` so a slow response from a
 * previous workflow id cannot clobber the freshly-selected workflow's
 * artifact view when the user switches rapidly through the list.
 *
 * `workflowId === null` short-circuits the fetch — the hook returns
 * an empty state without ever hitting the network. The Artifacts tab
 * never mounts in that branch but the guard keeps the hook safe to
 * call regardless.
 */
export function useWorkflowArtifacts(
  workflowId: string | null,
  isRunning: boolean,
): UseWorkflowArtifactsResult {
  const [artifacts, setArtifacts] = useState<WorkflowArtifactsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const mounted = useMounted();
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (workflowId === null) return;
    const seq = ++requestSeqRef.current;
    try {
      const result = await listWorkflowArtifacts(workflowId);
      if (!mounted.current || seq !== requestSeqRef.current) return;
      setArtifacts(result);
      setError(null);
      setLoaded(true);
    } catch (e) {
      if (!mounted.current || seq !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    }
  }, [workflowId]);

  useEffect(() => {
    setArtifacts(null);
    setError(null);
    setLoaded(false);
    if (workflowId === null) return;
    void refresh();
  }, [workflowId, refresh]);

  useEffect(() => {
    if (workflowId === null) return;
    if (!isRunning) return;
    const handle = setInterval(() => {
      void refresh();
    }, WORKFLOW_POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [workflowId, isRunning, refresh]);

  return { artifacts, error, loaded, refresh };
}
