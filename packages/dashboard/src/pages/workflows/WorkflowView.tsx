import { type ReactNode, useCallback, useRef, useState } from "react";
import type { WorkflowDagWire, WorkflowHeaderWire, WorkflowNodeWire } from "../../api";
import { WorkflowMetaChips } from "../../components/workflows/WorkflowMetaChips";
import { WorkflowStatusBadge } from "../../components/workflows/WorkflowStatusBadge";
import { ArtifactsTab } from "./ArtifactsTab";
import { GraphTab } from "./GraphTab";
import { OverviewTab } from "./OverviewTab";

export type WorkflowTab = "overview" | "graph" | "artifacts";

const TAB_ORDER: readonly WorkflowTab[] = ["overview", "graph", "artifacts"];

const TAB_LABEL: Record<WorkflowTab, string> = {
  overview: "Overview",
  graph: "Graph",
  artifacts: "Artifacts",
};

export interface WorkflowViewProps {
  workflow: WorkflowHeaderWire;
  dag: WorkflowDagWire | null;
  dagError: string | null;
  /**
   * Currently-selected node id (if any). Forwarded to the Graph tab so
   * the matching chip can paint `aria-current="true"` while the Mode B
   * detail pane is open in the parent.
   */
  selectedNodeId?: string | null;
  /**
   * Fired when a node chip is activated. Parent uses it to enter Mode B
   * (flips `?nodeTaskId=...` in the URL state machine).
   */
  onSelectNode: (node: WorkflowNodeWire) => void;
  /**
   * Optional slot for a trailing chrome row (e.g. the "Back to workflow"
   * pill + prev/next walker rendered by `WorkflowNodeTaskPane`). When
   * supplied, the header lays it out flush-right beside the title.
   */
  headerTrailing?: ReactNode;
}

/**
 * Three-tab host for a single workflow. The header chrome (badge +
 * brief + meta chips) is shared across all three tabs; the tab body
 * is the only thing that swaps.
 *
 * Row-level actions (Cancel workflow, Copy ID) moved off the detail
 * pane in v2.2 — they live on the `WorkflowListItem` `⋯` menu so the
 * detail pane stays a pure information surface (mirrors Tasks /
 * Schedules; see the row item for the rationale).
 *
 * Tab state is local — the URL does NOT carry the active tab. The
 * spec calls this out explicitly: switching tabs should not pollute
 * back/forward history. Tab state resets per workflow via the
 * `key={workflowId}` prop the caller is expected to pass on the
 * component itself when mounting from a master/detail page.
 *
 * Keyboard model is the WAI-ARIA tablist pattern:
 *   - ArrowLeft / ArrowRight rotate the active tab (no wrap stop).
 *   - Home / End jump to the first / last tab.
 *   - Tab/Shift+Tab moves focus OUT of the tablist (roving tabindex).
 *
 * The tablist itself uses `role="tablist"`; each tab is a `<button>`
 * with `role="tab"` + `aria-selected` + `aria-controls`; the active
 * panel uses `role="tabpanel"` with a matching `aria-labelledby`.
 */
export function WorkflowView({
  workflow,
  dag,
  dagError,
  selectedNodeId,
  onSelectNode,
  headerTrailing,
}: WorkflowViewProps) {
  const [active, setActive] = useState<WorkflowTab>("overview");
  const tabRefs = useRef<Map<WorkflowTab, HTMLButtonElement | null>>(new Map());

  const setTabRef = useCallback(
    (tab: WorkflowTab) => (el: HTMLButtonElement | null) => {
      tabRefs.current.set(tab, el);
    },
    [],
  );

  const focusTab = useCallback((tab: WorkflowTab) => {
    const el = tabRefs.current.get(tab) ?? null;
    if (el !== null) el.focus();
  }, []);

  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const idx = TAB_ORDER.indexOf(active);
      if (idx < 0) return;
      let next: WorkflowTab | null = null;
      if (e.key === "ArrowRight") {
        next = TAB_ORDER[Math.min(TAB_ORDER.length - 1, idx + 1)] ?? null;
      } else if (e.key === "ArrowLeft") {
        next = TAB_ORDER[Math.max(0, idx - 1)] ?? null;
      } else if (e.key === "Home") {
        next = TAB_ORDER[0] ?? null;
      } else if (e.key === "End") {
        next = TAB_ORDER[TAB_ORDER.length - 1] ?? null;
      }
      if (next !== null && next !== active) {
        e.preventDefault();
        setActive(next);
        // Defer focus so React commits the new `tabIndex={0}` first.
        queueMicrotask(() => focusTab(next as WorkflowTab));
      }
    },
    [active, focusTab],
  );

  return (
    <aside className="tasks-pane__detail workflow-detail" data-testid="workflow-detail">
      <header className="workflow-detail__header">
        <div className="workflow-detail__header-row">
          <WorkflowStatusBadge status={workflow.status} />
          <h2 className="workflow-detail__title" title={workflow.brief}>
            {workflow.brief}
          </h2>
          {headerTrailing !== undefined ? (
            <div className="workflow-detail__header-trailing">{headerTrailing}</div>
          ) : null}
        </div>
        <div className="workflow-detail__meta muted">
          <code
            className="task-list__id"
            title={`Workflow id: ${workflow.id}`}
            data-testid="workflow-detail-id"
          >
            {workflow.id}
          </code>
        </div>
        <WorkflowMetaChips workflow={workflow} dag={dag} />
      </header>

      <div
        className="workflow-tabs"
        role="tablist"
        aria-label="Workflow detail sections"
        data-testid="workflow-tabs"
      >
        {TAB_ORDER.map((tab) => {
          const selected = tab === active;
          return (
            <button
              key={tab}
              ref={setTabRef(tab)}
              type="button"
              role="tab"
              id={`workflow-tab-${tab}`}
              aria-selected={selected}
              aria-controls={`workflow-tabpanel-${tab}`}
              tabIndex={selected ? 0 : -1}
              className={`workflow-tabs__btn${selected ? " workflow-tabs__btn--active" : ""}`}
              data-testid={`workflow-tab-${tab}`}
              onClick={() => setActive(tab)}
              onKeyDown={onTabKeyDown}
            >
              {TAB_LABEL[tab]}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`workflow-tabpanel-${active}`}
        aria-labelledby={`workflow-tab-${active}`}
        className="workflow-tabpanel"
        data-testid={`workflow-tabpanel-${active}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabpanel pattern requires the panel itself to be focusable (`tabIndex=0`) when it has no focusable descendants so the keyboard user can shift-tab into it.
        tabIndex={0}
      >
        {active === "overview" ? <OverviewTab workflow={workflow} /> : null}
        {active === "graph" ? (
          <GraphTab
            dag={dag}
            dagError={dagError}
            selectedNodeId={selectedNodeId ?? null}
            onSelectNode={onSelectNode}
          />
        ) : null}
        {active === "artifacts" ? <ArtifactsTab workflow={workflow} dag={dag} /> : null}
      </div>
    </aside>
  );
}
