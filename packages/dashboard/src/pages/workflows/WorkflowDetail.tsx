import type { WorkflowDagWire, WorkflowHeaderWire, WorkflowNodeWire } from "../../api";
import { WorkflowView } from "./WorkflowView";

export interface WorkflowDetailProps {
  workflow: WorkflowHeaderWire;
  dag: WorkflowDagWire | null;
  dagError: string | null;
  /** Bumped by the parent on Cancel success so the detail can re-render the new status banner. */
  cancelBusy: boolean;
  onCancel: () => void;
  /** When non-null the parent has highlighted a node (Mode B in scope). */
  selectedNodeId?: string | null;
  /** Fired from the Graph tab when the user activates a node chip. */
  onSelectNode: (node: WorkflowNodeWire) => void;
}

/**
 * Right-pane workflow detail. Now a one-line forwarder to
 * {@link WorkflowView}: the tab host owns all rendering, this file
 * exists only to keep the existing import path stable for callers
 * outside the page (e.g. snapshot tests, storybook).
 */
export function WorkflowDetail(props: WorkflowDetailProps) {
  return <WorkflowView {...props} />;
}
