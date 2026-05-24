import type { AgentEntry } from "@emploke/catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelTask, deleteTask, dispatchTask, type ServerConfig, type TaskRecord } from "../api";
import { HeaderActions } from "../components/HeaderActions";
import { DispatchModal } from "../components/tasks/DispatchModal";
import { TaskConfirmModalsHost } from "../components/tasks/TaskConfirmModals";
import { TaskDetail } from "../components/tasks/TaskDetail";
import { TaskFilters } from "../components/tasks/TaskFilters";
import { TaskList } from "../components/tasks/TaskList";
import {
  TaskDetailPlaceholder,
  TasksEmptyState,
  TasksToolbar,
} from "../components/tasks/TasksChrome";
import { useSelectedTask } from "../hooks/useSelectedTask";
import { useTasks } from "../hooks/useTasks";

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

/**
 * Tasks page — fire-and-forget agent dispatch, autonomous run,
 * polling detail view. Master-detail layout: a filtered + grouped
 * task list on the left, a tabbed detail panel on the right.
 *
 * Phase A redesign:
 *   - Refresh / Dispatch live in the workspace chrome header (via
 *     `<HeaderActions>`); no separate `.page-toolbar--tasks` strip.
 *   - The detail pane is always 2-column. The right column shows
 *     either `<TaskDetail>` for the selected task, or a calm
 *     placeholder when the list is empty.
 *   - Origin filter is dropped — the Tasks page is standalone-only;
 *     workflow-origin tasks surface on a separate (future) page.
 *
 * This file is a thin shell — page-level data loading lives in
 * {@link useTasks}, per-task detail loading in `useTaskDetail`,
 * URL selection in {@link useSelectedTask}.
 */
export function TasksPage({ agents, currentWorkspaceId, config, fixedAgentFqn }: TasksProps) {
  const pollIntervalMs = config?.tasks?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const { selectedId, setSelectedId } = useSelectedTask();
  const data = useTasks({
    currentWorkspaceId,
    pollIntervalMs,
    ...(fixedAgentFqn !== undefined ? { fixedAgentFqn } : {}),
  });
  const {
    tasks,
    runtimes,
    loaded,
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
  } = data;

  const [dispatchOpen, setDispatchOpen] = useState(false);
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
    if (q === "") return tasks;
    return tasks.filter((t) => t.id.toLowerCase().includes(q));
  }, [tasks, idQuery]);

  // Phase A default-selection rule: as soon as the list loads (or
  // filters change such that the current selection is no longer
  // visible), auto-bind to the top-most task. When the visible list
  // is empty, clear the selection so the right column falls back to
  // the placeholder.
  useEffect(() => {
    if (!loaded) return;
    if (visibleTasks.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !visibleTasks.some((t) => t.id === selectedId)) {
      setSelectedId(visibleTasks[0].id);
    }
  }, [loaded, visibleTasks, selectedId, setSelectedId]);

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
              agents={agents}
              filterAgentNames={filterAgentNames}
              runtimes={runtimes}
              hideAgentFilter={fixedAgentFqn !== undefined}
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
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onDelete={setDeleteTarget}
                  onCancel={requestCancel}
                  onRerun={requestRerun}
                />
              )}
            </div>
          </div>

          {selectedId ? (
            <TaskDetail taskId={selectedId} pollIntervalMs={pollIntervalMs} />
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
