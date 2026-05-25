import type { AgentEntry } from "@emploke/catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelTask, deleteTask, dispatchTask, type ServerConfig, type TaskRecord } from "../api";
import { HeaderActions } from "../components/HeaderActions";
import { LegacyMovedBanner } from "../components/LegacyMovedBanner";
import { DispatchModal } from "../components/tasks/DispatchModal";
import {
  ALL_AGENTS,
  ALL_RUNTIMES,
  statusGroup,
  TIME_PRESETS,
  type TimePreset,
} from "../components/tasks/shared";
import { TaskConfirmModalsHost } from "../components/tasks/TaskConfirmModals";
import { TaskDetail } from "../components/tasks/TaskDetail";
import { type StatusFilter, TaskFilters } from "../components/tasks/TaskFilters";
import { TaskList } from "../components/tasks/TaskList";
import {
  TaskDetailPlaceholder,
  TasksEmptyState,
  TasksToolbar,
} from "../components/tasks/TasksChrome";
import { useSelectedTask } from "../hooks/useSelectedTask";
import { useTasks } from "../hooks/useTasks";
import { useClearUrlFilters, useUrlSearchValue } from "../hooks/useUrlState";

interface TasksProps {
  agents: AgentEntry[];
  /** UUID of the workspace currently in scope (from the URL); null = no workspace. */
  currentWorkspaceId: string | null;
  /** Server-supplied config; null while still being fetched. */
  config: ServerConfig | null;
  /**
   * When set (per-agent Tasks tab), the page hides the agent filter
   * control, locks the data fetch to this agent, and restricts the
   * dispatch modal so the new task is owned by the same agent.
   */
  fixedAgentFqn?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 4000;
const DEFAULT_TIME_PRESET: TimePreset = "7d";
const VALID_STATUS_FILTERS: ReadonlyArray<StatusFilter> = ["all", "running", "completed"];

function coerceTimePreset(raw: string): TimePreset {
  const match = TIME_PRESETS.find((p) => p.value === raw);
  return match ? match.value : DEFAULT_TIME_PRESET;
}

function coerceStatusFilter(raw: string): StatusFilter {
  return (VALID_STATUS_FILTERS as ReadonlyArray<string>).includes(raw)
    ? (raw as StatusFilter)
    : "all";
}

/**
 * Tasks page — fire-and-forget agent dispatch, autonomous run,
 * polling detail view. Master-detail layout: a filtered + grouped
 * task list on the left, a tabbed detail panel on the right.
 *
 * Phase 1.5 Block G — every filter (`?agent`, `?runtime`, `?range`,
 * `?q`, `?status`) plus the master-detail selection (`?taskId`) is
 * URL-driven via {@link useUrlSearchValue}, so refresh / back-button
 * / shared link all reproduce the same view.
 */
export function TasksPage({ agents, currentWorkspaceId, config, fixedAgentFqn }: TasksProps) {
  const pollIntervalMs = config?.tasks?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // URL-driven filter state. fixedAgentFqn (per-agent embed) takes
  // precedence over the URL `?agent=` slot.
  const [idQuery, setIdQuery] = useUrlSearchValue("q", "");
  const [agentFilterUrl, setAgentFilterUrl] = useUrlSearchValue("agent", ALL_AGENTS);
  const [runtimeFilter, setRuntimeFilter] = useUrlSearchValue("runtime", ALL_RUNTIMES);
  const [rangeUrl, setRangeUrl] = useUrlSearchValue("range", DEFAULT_TIME_PRESET);
  const [statusUrl, setStatusUrl] = useUrlSearchValue("status", "all");
  const clearFilters = useClearUrlFilters();

  const agentFilter = fixedAgentFqn ?? agentFilterUrl;
  const setAgentFilter = fixedAgentFqn ? () => {} : setAgentFilterUrl;
  const timeFilter = coerceTimePreset(rangeUrl);
  const setTimeFilter = (v: TimePreset) => setRangeUrl(v);
  const statusFilter = coerceStatusFilter(statusUrl);
  const setStatusFilter = (v: StatusFilter) => setStatusUrl(v);

  const { selectedId, setSelectedId } = useSelectedTask();
  const data = useTasks({
    currentWorkspaceId,
    pollIntervalMs,
    agentFilter,
    runtimeFilter,
    timeFilter,
  });
  const { tasks, runtimes, loaded, error, setError, refresh } = data;

  const [dispatchOpen, setDispatchOpen] = useState(false);

  // Phase 1.5 §4.3 — the agent-detail "+ New task" button deep-links to
  // this page with `?dispatch=1` (plus `?agent=<fqn>`) so the dispatch
  // modal opens with the agent pre-selected. We honour the flag once on
  // mount, then strip it from the URL so a refresh/back doesn't re-open
  // the modal.
  const [dispatchFlagUrl, setDispatchFlagUrl] = useUrlSearchValue("dispatch", "");
  useEffect(() => {
    if (dispatchFlagUrl !== "1") return;
    setDispatchOpen(true);
    setDispatchFlagUrl("");
  }, [dispatchFlagUrl, setDispatchFlagUrl]);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TaskRecord | null>(null);
  const [deletePurge, setDeletePurge] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<TaskRecord | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [rerunFrom, setRerunFrom] = useState<TaskRecord | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const onDispatched = async (
    agent: string,
    brief: string,
    details: string | undefined,
    runtime: string | undefined,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const created = await dispatchTask(agent, brief, details, runtime);
      if (!mountedRef.current) return;
      setDispatchOpen(false);
      setRerunFrom(null);
      setSelectedId(created.id);
      await refresh();
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const onConfirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setError(null);
    try {
      await deleteTask(deleteTarget.id, { purge: deletePurge });
      if (!mountedRef.current) return;
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
      setDeletePurge(false);
      await refresh();
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const requestCancel = useCallback((target: TaskRecord) => {
    setCancelError(null);
    setCancelTarget(target);
  }, []);

  const requestRerun = useCallback((target: TaskRecord) => {
    setRerunFrom(target);
    setDispatchOpen(true);
  }, []);

  const closeCancelModal = useCallback(() => {
    if (cancelBusy) return;
    setCancelTarget(null);
    setCancelError(null);
  }, [cancelBusy]);

  const onConfirmCancel = useCallback(async () => {
    if (!cancelTarget || cancelBusy) return;
    const target = cancelTarget;
    setCancelBusy(true);
    setCancelError(null);
    try {
      await cancelTask(target.id);
      if (!mountedRef.current) return;
      setCancelTarget(null);
      await refresh();
    } catch (e) {
      if (!mountedRef.current) return;
      const msg = (e as Error).message;
      // 409 = already terminal; benign race — next refresh re-syncs.
      if (/409/.test(msg)) {
        setCancelTarget(null);
        await refresh();
        return;
      }
      setCancelError(msg);
    } finally {
      if (mountedRef.current) setCancelBusy(false);
    }
  }, [cancelTarget, cancelBusy, refresh]);

  const readyAgents = agents.filter((a) => a.status === "ready");
  const dispatchAgents = fixedAgentFqn
    ? readyAgents.filter((a) => a.agent.fqn === fixedAgentFqn)
    : readyAgents;

  const visibleTasks = useMemo(() => {
    const q = idQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (q !== "" && !t.id.toLowerCase().includes(q)) return false;
      // Status filter narrows by the same Running / Completed bucket
      // the list groups into — `all` keeps both, `running` drops the
      // completed group, `completed` drops the running group.
      if (statusFilter !== "all" && statusGroup(t.status) !== statusFilter) return false;
      return true;
    });
  }, [tasks, idQuery, statusFilter]);

  // Phase A default-selection rule: auto-bind to the top-most visible
  // task when the URL doesn't already pin one with `?taskId=` and the
  // list is non-empty. Derived during render so it doesn't race the
  // URL-clearing path (Phase 1.5 Block G — earlier auto-select-via-
  // effect would silently re-introduce filter params it captured in a
  // stale closure when the user clicked Clear filters).
  //
  // Side-effect path (URL writes): only `setSelectedId` from user
  // interactions writes to the URL — the auto-fallback stays component-
  // local so `?taskId=` reflects deliberate selection, not the
  // implicit "first row".
  const effectiveSelectedId = useMemo(() => {
    if (selectedId !== null && visibleTasks.some((t) => t.id === selectedId)) {
      return selectedId;
    }
    if (loaded && visibleTasks.length > 0) return visibleTasks[0].id;
    return null;
  }, [selectedId, loaded, visibleTasks]);

  const filterAgentNames = useMemo(() => {
    const set = new Set<string>(agents.map((a) => a.agent.fqn));
    for (const t of tasks) set.add(t.agent);
    return Array.from(set).sort();
  }, [agents, tasks]);

  if (currentWorkspaceId === null) {
    return (
      <div className="alert alert--error">
        No workspace is selected. Use the workspace dropdown in the top bar to choose or create one
        — tasks are scoped to a workspace.
      </div>
    );
  }

  return (
    <>
      <HeaderActions>
        <TasksToolbar
          dispatchDisabled={dispatchAgents.length === 0}
          dispatchDisabledTitle={
            dispatchAgents.length === 0
              ? fixedAgentFqn
                ? `Agent ${fixedAgentFqn} is not ready — see Catalog`
                : "Install at least one ready agent in the Catalog first"
              : "Dispatch a new task"
          }
          onDispatch={() => setDispatchOpen(true)}
        />
      </HeaderActions>

      <div className="tasks-page">
        {!fixedAgentFqn && <LegacyMovedBanner page="tasks" />}
        {error && <div className="alert alert--error">⚠️ {error}</div>}

        <div className="tasks-pane tasks-pane--with-detail">
          <div className="tasks-pane__list">
            <TaskFilters
              idQuery={idQuery}
              onIdQueryChange={setIdQuery}
              agentFilter={agentFilter}
              onAgentFilterChange={setAgentFilter}
              runtimeFilter={runtimeFilter}
              onRuntimeFilterChange={setRuntimeFilter}
              timeFilter={timeFilter}
              onTimeFilterChange={setTimeFilter}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              agents={agents}
              filterAgentNames={filterAgentNames}
              runtimes={runtimes}
              hideAgentFilter={fixedAgentFqn !== undefined}
              onClearFilters={fixedAgentFqn ? undefined : clearFilters}
            />
            <div className="tasks-pane__list-scroll">
              {!loaded ? (
                <TasksEmptyState loading />
              ) : visibleTasks.length === 0 ? (
                <TasksEmptyState
                  title={tasks.length === 0 ? "No tasks yet" : "No matches"}
                  hint={
                    tasks.length === 0
                      ? "Dispatch a task to run an agent autonomously and read the result here when it finishes."
                      : "Adjust the filters above to see more tasks."
                  }
                />
              ) : (
                <TaskList
                  tasks={visibleTasks}
                  selectedId={effectiveSelectedId}
                  onSelect={setSelectedId}
                  onDelete={setDeleteTarget}
                  onCancel={requestCancel}
                  onRerun={requestRerun}
                />
              )}
            </div>
          </div>

          {effectiveSelectedId ? (
            <TaskDetail taskId={effectiveSelectedId} pollIntervalMs={pollIntervalMs} />
          ) : (
            <TaskDetailPlaceholder zeroTasks={tasks.length === 0} />
          )}
        </div>
      </div>

      <DispatchModal
        open={dispatchOpen}
        agents={dispatchAgents}
        runtimes={runtimes}
        busy={busy}
        prefill={rerunFrom}
        onClose={() => {
          setDispatchOpen(false);
          setRerunFrom(null);
        }}
        onDispatch={onDispatched}
      />

      <TaskConfirmModalsHost
        cancelTarget={cancelTarget}
        cancelBusy={cancelBusy}
        cancelError={cancelError}
        onCloseCancel={closeCancelModal}
        onConfirmCancel={onConfirmCancel}
        deleteTarget={deleteTarget}
        deleteBusy={busy}
        deletePurge={deletePurge}
        onDeletePurgeChange={setDeletePurge}
        onCloseDelete={() => {
          setDeleteTarget(null);
          setDeletePurge(false);
        }}
        onConfirmDelete={onConfirmDelete}
      />
    </>
  );
}
