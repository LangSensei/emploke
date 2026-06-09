import type { WorkflowDagWire, WorkflowNodeWire } from "../../api";
import { WorkflowDagView } from "./WorkflowDagView";

export interface GraphTabProps {
  dag: WorkflowDagWire | null;
  dagError: string | null;
  selectedNodeId: string | null;
  onSelectNode: (node: WorkflowNodeWire) => void;
}

/**
 * Graph tab — hosts the {@link WorkflowDagView} with the loading /
 * error guards inlined. The tab is the only Mode B entry point —
 * clicking a node with `taskId` set fires `onSelectNode` so the
 * parent can flip its URL state to the node-task pane.
 *
 * Nodes without a dispatched task (the narrow window between insert
 * and dispatch, or a future kind that has no task seam) render as
 * inert chips: the rendering pass marks them `aria-disabled` and
 * the click handler short-circuits. This is intentional — there's
 * nothing to navigate to until the dispatcher writes `taskId`.
 */
export function GraphTab({ dag, dagError, selectedNodeId, onSelectNode }: GraphTabProps) {
  if (dagError !== null) {
    return (
      <div className="workflow-graph" data-testid="workflow-graph-tab">
        <div className="alert alert--error" data-testid="workflow-dag-error">
          ⚠️ {dagError}
        </div>
      </div>
    );
  }
  if (dag === null) {
    return (
      <div className="workflow-graph" data-testid="workflow-graph-tab">
        <div className="empty" data-testid="workflow-dag-loading">
          <p className="empty__title">Loading DAG…</p>
        </div>
      </div>
    );
  }
  return (
    <div className="workflow-graph" data-testid="workflow-graph-tab">
      <WorkflowDagView dag={dag} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
    </div>
  );
}
