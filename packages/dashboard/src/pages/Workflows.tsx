import type { AgentEntry } from "@emploke/contracts";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  cancelWorkflow,
  type ServerConfig,
  type WorkflowHeaderWire,
  type WorkflowNodeWire,
} from "../api";
import { HeaderActions } from "../components/HeaderActions";
import { PlusIcon } from "../components/Icons";
import { CreateWorkflowModal } from "../components/workflows/CreateWorkflowModal";
import { ALL_STATUS, STATUS_FILTERS, type StatusFilter } from "../components/workflows/shared";
import { CancelWorkflowModal } from "../components/workflows/WorkflowConfirmModals";
import { WorkflowList } from "../components/workflows/WorkflowList";
import { useMounted } from "../hooks/useMounted";
import { useUrlSearchValue } from "../hooks/useUrlState";
import { useWorkflowDetail } from "../hooks/useWorkflowDetail";
import { useWorkflows } from "../hooks/useWorkflows";
import { WorkflowDetail } from "./workflows/WorkflowDetail";
import { WorkflowNodeTaskPane } from "./workflows/WorkflowNodeTaskPane";

export interface WorkflowsPageProps {
  agents: AgentEntry[];
  /** UUID of the workspace currently in scope (from the URL); null = no workspace. */
  currentWorkspaceId: string | null;
  /**
   * Server-supplied config; null while still being fetched. Used to
   * source the Mode B per-task poll interval so the value matches the
   * Tasks page (`config.tasks.pollIntervalMs`) instead of drifting on
   * a Workflows-local constant.
   */
  config?: ServerConfig | null;
}

const DEFAULT_NODE_TASK_POLL_INTERVAL_MS = 4000;

/**
 * Workflows page — workspace-scoped master-detail view for the
 * `@emploke/workflow` substrate.
 *
 * URL-driven state machine (mirrors the Schedules page's atomic
 * `setMasterDetailUrl` pattern):
 *
 *   - `?status=running|succeeded|failed|cancelled|all` — list filter
 *     (default `all`, encoded as the {@link ALL_STATUS} sentinel)
 *   - `?workflowId=<wfid>` — master-detail selection
 *   - `?nodeTaskId=<taskId>` — Mode B drill-down (right pane swaps
 *     from the {@link WorkflowDetail} tab host to the full
 *     {@link WorkflowNodeTaskPane})
 *
 * When `nodeTaskId` is present, the right pane is the node-task drill
 * (with a header pill walking the workflow's nodes in execution
 * order). When it's absent, the right pane is the standard 3-tab
 * `WorkflowDetail`. Tab state is component-local and does NOT
 * round-trip through the URL.
 */
export function WorkflowsPage({ agents, currentWorkspaceId, config }: WorkflowsPageProps) {
  const nodeTaskPollIntervalMs =
    config?.tasks?.pollIntervalMs ?? DEFAULT_NODE_TASK_POLL_INTERVAL_MS;
  const navigate = useNavigate();
  const location = useLocation();
  const [statusFilterRaw, setStatusFilterRaw] = useUrlSearchValue("status", ALL_STATUS);
  const [selectedIdRaw] = useUrlSearchValue("workflowId", "");
  const [nodeTaskIdRaw] = useUrlSearchValue("nodeTaskId", "");
  const statusFilter = coerceStatusFilter(statusFilterRaw);
  const setStatusFilter = useCallback(
    (v: StatusFilter) => setStatusFilterRaw(v),
    [setStatusFilterRaw],
  );
  const selectedId = selectedIdRaw === "" ? null : selectedIdRaw;
  const nodeTaskId = nodeTaskIdRaw === "" ? null : nodeTaskIdRaw;

  // Atomic URL writer: updates `workflowId` and `nodeTaskId` in a
  // single `navigate()` call so two sequential single-key setters
  // can't race via stale `location.search` snapshots. Pass
  // `undefined` to leave a key untouched, empty string / null to
  // delete it.
  const setMasterDetailUrl = useCallback(
    (next: { workflowId?: string | null; nodeTaskId?: string | null }) => {
      const params = new URLSearchParams(location.search);
      if (next.workflowId !== undefined) {
        if (next.workflowId === null || next.workflowId === "") params.delete("workflowId");
        else params.set("workflowId", next.workflowId);
      }
      if (next.nodeTaskId !== undefined) {
        if (next.nodeTaskId === null || next.nodeTaskId === "") params.delete("nodeTaskId");
        else params.set("nodeTaskId", next.nodeTaskId);
      }
      const search = params.toString();
      navigate(`${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`, {
        replace: true,
      });
    },
    [navigate, location.pathname, location.search, location.hash],
  );

  const { workflows, loaded, error, setError, refresh } = useWorkflows({
    currentWorkspaceId,
    statusFilter,
  });

  const visible = workflows;

  const effectiveSelectedId =
    selectedId !== null && visible.some((w) => w.id === selectedId)
      ? selectedId
      : loaded && visible.length > 0
        ? (visible[0]?.id ?? null)
        : null;

  const detail = useWorkflowDetail(effectiveSelectedId);

  // Compute the selected node id for the Graph tab's highlight. When
  // Mode B is active (`nodeTaskId` set), map it back to a node id via
  // the dag — the selected node is "the node whose taskId matches the
  // URL." A dag that hasn't loaded yet keeps the selection null so
  // the chip just renders un-styled.
  const selectedNodeId =
    nodeTaskId !== null && detail.dag !== null
      ? (detail.dag.nodes.find((n) => n.taskId === nodeTaskId)?.id ?? null)
      : null;

  // Master selection write: clears any in-flight Mode B at the same
  // time so the right pane never falls into the inconsistent state
  // "workflow A's header + workflow B's nodeTaskId."
  const onSelectWorkflow = useCallback(
    (id: string | null) => {
      setMasterDetailUrl({ workflowId: id, nodeTaskId: null });
    },
    [setMasterDetailUrl],
  );

  // Mode B entry: parent renders the node-task pane on the right.
  // Nodes without a `taskId` (transient: dispatched but not yet
  // recorded) are silently skipped — the Graph tab's button is also
  // `aria-disabled` in that case so this branch is defence in depth.
  const onSelectNode = useCallback(
    (node: WorkflowNodeWire) => {
      if (node.taskId === undefined) return;
      setMasterDetailUrl({ nodeTaskId: node.taskId });
    },
    [setMasterDetailUrl],
  );

  const onBackToWorkflow = useCallback(() => {
    setMasterDetailUrl({ nodeTaskId: null });
  }, [setMasterDetailUrl]);

  const onNavigateNode = useCallback(
    (nextTaskId: string) => {
      setMasterDetailUrl({ nodeTaskId: nextTaskId });
    },
    [setMasterDetailUrl],
  );

  const mounted = useMounted();
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<WorkflowHeaderWire | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const handleCreated = useCallback(
    (created: WorkflowHeaderWire) => {
      setError(null);
      setMasterDetailUrl({ workflowId: created.id, nodeTaskId: null });
      // If the active status filter would hide the new row (its
      // initial status is always `running`), reset the filter so the
      // user sees the freshly-dispatched workflow.
      if (statusFilter !== ALL_STATUS && statusFilter !== "running") {
        setStatusFilter(ALL_STATUS);
      }
      // Best-effort: refresh the list so the new row is sourced from
      // the server rather than synthesised on the client.
      void refresh();
    },
    [refresh, setError, setMasterDetailUrl, statusFilter, setStatusFilter],
  );

  const handleConfirmCancel = useCallback(
    async (reason: string) => {
      if (!cancelTarget) return;
      setCancelBusy(true);
      setCancelError(null);
      try {
        await cancelWorkflow(cancelTarget.id, {
          cancellation: { kind: "user", message: reason },
        });
        if (!mounted.current) return;
        setCancelTarget(null);
        await refresh();
        await detail.refresh();
      } catch (e) {
        if (!mounted.current) return;
        setCancelError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted.current) setCancelBusy(false);
      }
    },
    [cancelTarget, detail, refresh],
  );

  // When the selected workflow ends, surface the freshly-terminal row
  // by pulling the server state once more so the row's row-tint stops
  // pulsing without waiting for the next list-polling tick.
  useEffect(() => {
    if (detail.workflow === null) return;
    if (detail.workflow.status === "running") return;
    if (visible.some((w) => w.id === detail.workflow?.id && w.status !== detail.workflow.status)) {
      void refresh();
    }
  }, [detail.workflow, visible, refresh]);

  if (currentWorkspaceId === null) {
    return (
      <div className="alert alert--error">
        No workspace is selected. Use the workspace dropdown in the top bar to choose or create one
        — workflows are scoped to a workspace.
      </div>
    );
  }

  const filtersActive = statusFilter !== ALL_STATUS;
  const detailWorkflow = detail.workflow;
  const showNodeTaskPane = nodeTaskId !== null && effectiveSelectedId !== null;

  return (
    <>
      <HeaderActions>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setCreateOpen(true)}
          disabled={agents.length === 0}
          title={
            agents.length === 0
              ? "Install at least one agent in the Catalog before creating workflows"
              : "Create a new workflow"
          }
          data-testid="workflows-new-cta"
        >
          <PlusIcon />
          <span>New workflow</span>
        </button>
      </HeaderActions>

      <div className="tasks-page">
        {error && <div className="alert alert--error">⚠️ {error}</div>}
        {loaded && workflows.length === 0 && !filtersActive ? (
          <div className="tasks-pane tasks-pane--with-detail tasks-pane--zero">
            <div className="empty tasks-pane__zero" data-testid="workflows-empty-zero">
              <div className="empty__icon" aria-hidden="true">
                🪄
              </div>
              <p className="empty__title">No workflows yet</p>
              <p className="empty__hint">
                Click <strong>New workflow</strong> to dispatch a coordinator-driven multi-step run.
                The coordinator decides which task and follow-up coordinator nodes to spawn next —
                each phase wakes the next one when the previous worker terminates.
              </p>
            </div>
          </div>
        ) : (
          <div className="tasks-pane tasks-pane--with-detail">
            <div className="tasks-pane__list">
              <WorkflowsFilters
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
              />
              <div className="tasks-pane__list-scroll">
                {!loaded ? (
                  <div className="empty">
                    <p className="empty__title">Loading workflows…</p>
                  </div>
                ) : visible.length === 0 ? (
                  <div className="empty" data-testid="workflows-empty-filtered">
                    <p className="empty__title">No matches</p>
                    <p className="empty__hint">
                      Adjust the status filter above to see more workflows.
                    </p>
                  </div>
                ) : (
                  <WorkflowList
                    workflows={visible}
                    selectedId={effectiveSelectedId}
                    onSelect={onSelectWorkflow}
                  />
                )}
              </div>
            </div>

            {(() => {
              if (showNodeTaskPane && detailWorkflow !== null) {
                return (
                  <WorkflowNodeTaskPane
                    key={`${effectiveSelectedId}:${nodeTaskId}`}
                    workflow={detailWorkflow}
                    dag={detail.dag}
                    nodeTaskId={nodeTaskId as string}
                    pollIntervalMs={nodeTaskPollIntervalMs}
                    onBack={onBackToWorkflow}
                    onNavigate={onNavigateNode}
                  />
                );
              }
              if (effectiveSelectedId !== null && detailWorkflow !== null) {
                return (
                  <WorkflowDetail
                    key={effectiveSelectedId}
                    workflow={detailWorkflow}
                    dag={detail.dag}
                    dagError={detail.dagError}
                    cancelBusy={cancelBusy && cancelTarget?.id === detailWorkflow.id}
                    onCancel={() => setCancelTarget(detailWorkflow)}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={onSelectNode}
                  />
                );
              }
              if (effectiveSelectedId !== null && detail.error !== null) {
                return (
                  <aside className="tasks-pane__detail tasks-pane__detail--empty">
                    <div className="alert alert--error">⚠️ {detail.error}</div>
                  </aside>
                );
              }
              if (effectiveSelectedId !== null) {
                return (
                  <aside className="tasks-pane__detail tasks-pane__detail--empty">
                    <div className="empty">
                      <p className="empty__title">Loading workflow…</p>
                    </div>
                  </aside>
                );
              }
              if (visible.length === 0) return null;
              return (
                <aside className="tasks-pane__detail tasks-pane__detail--empty">
                  <div className="empty">
                    <div className="empty__icon">🪄</div>
                    <p className="empty__title">No workflow selected</p>
                  </div>
                </aside>
              );
            })()}
          </div>
        )}
      </div>

      {createOpen && (
        <CreateWorkflowModal
          open={createOpen}
          agents={agents}
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      )}

      {cancelTarget && (
        <CancelWorkflowModal
          target={cancelTarget}
          busy={cancelBusy}
          error={cancelError}
          onClose={() => {
            if (cancelBusy) return;
            setCancelTarget(null);
            setCancelError(null);
          }}
          onConfirm={handleConfirmCancel}
        />
      )}
    </>
  );
}

function coerceStatusFilter(raw: string): StatusFilter {
  switch (raw) {
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
      return raw;
    default:
      return ALL_STATUS;
  }
}

interface WorkflowsFiltersProps {
  statusFilter: StatusFilter;
  onStatusFilterChange: (next: StatusFilter) => void;
}

function WorkflowsFilters({ statusFilter, onStatusFilterChange }: WorkflowsFiltersProps) {
  return (
    <div className="tasks-filters" data-testid="workflows-filters">
      <label htmlFor="workflows-status-filter">
        <span className="muted" style={{ fontSize: 12, marginRight: 6 }}>
          Status
        </span>
        <select
          id="workflows-status-filter"
          value={statusFilter}
          onChange={(e) => onStatusFilterChange(e.target.value as StatusFilter)}
          className="select"
          data-testid="workflows-status-select"
        >
          {STATUS_FILTERS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
