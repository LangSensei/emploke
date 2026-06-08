import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkflow, getWorkflowDag, type WorkflowDagWire, type WorkflowHeaderWire } from "../api";
import { WORKFLOW_POLL_INTERVAL_MS } from "../components/workflows/shared";
import { useMounted } from "./useMounted";

export interface UseWorkflowDetailResult {
  workflow: WorkflowHeaderWire | null;
  dag: WorkflowDagWire | null;
  error: string | null;
  dagError: string | null;
  refresh: () => Promise<void>;
}

/**
 * Per-workflow detail data: fetches the header + DAG together so the
 * detail pane renders a consistent snapshot, polls every
 * {@link WORKFLOW_POLL_INTERVAL_MS}ms while the workflow is still
 * running, and stops polling as soon as the workflow reaches a
 * terminal status. Mirrors `useTaskDetail` without the SSE tail
 * subscription (workflows do not yet expose a stream surface).
 *
 * The monotonic `seq` guard prevents an in-flight response from a
 * prior workflow id from clobbering the freshly-selected workflow's
 * state when the user rapidly switches rows.
 */
export function useWorkflowDetail(workflowId: string | null): UseWorkflowDetailResult {
  const [workflow, setWorkflow] = useState<WorkflowHeaderWire | null>(null);
  const [dag, setDag] = useState<WorkflowDagWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dagError, setDagError] = useState<string | null>(null);
  const mounted = useMounted();
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!workflowId) return;
    const seq = ++requestSeqRef.current;
    try {
      const [header, dagResult] = await Promise.allSettled([
        getWorkflow(workflowId),
        getWorkflowDag(workflowId),
      ]);
      if (!mounted.current || seq !== requestSeqRef.current) return;
      if (header.status === "fulfilled") {
        setWorkflow(header.value);
        setError(null);
      } else {
        setError(header.reason instanceof Error ? header.reason.message : String(header.reason));
      }
      if (dagResult.status === "fulfilled") {
        setDag(dagResult.value);
        setDagError(null);
      } else {
        setDagError(
          dagResult.reason instanceof Error ? dagResult.reason.message : String(dagResult.reason),
        );
      }
    } catch (e) {
      if (!mounted.current || seq !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [workflowId]);

  // Reset state on workflow swap so the new selection doesn't briefly
  // show the previous workflow's payload.
  useEffect(() => {
    setWorkflow(null);
    setDag(null);
    setError(null);
    setDagError(null);
    if (!workflowId) return;
    void refresh();
  }, [workflowId, refresh]);

  useEffect(() => {
    if (!workflowId) return;
    if (workflow === null) return;
    if (workflow.status !== "running") return;
    const handle = setInterval(() => {
      void refresh();
    }, WORKFLOW_POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [workflowId, workflow, refresh]);

  return { workflow, dag, error, dagError, refresh };
}
