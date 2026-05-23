import type { AgentEntry } from "@emploke/catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelTask, deleteTask, dispatchTask, type ServerConfig, type TaskRecord } from "../api";
import { DispatchModal } from "../components/tasks/DispatchModal";
import { TaskConfirmModalsHost } from "../components/tasks/TaskConfirmModals";
import { TaskDetail } from "../components/tasks/TaskDetail";
import { TaskFilters } from "../components/tasks/TaskFilters";
import { TaskList } from "../components/tasks/TaskList";
import { TasksEmptyState, TasksToolbar } from "../components/tasks/TasksChrome";
import { useSelectedTask } from "../hooks/useSelectedTask";
import { useTasks } from "../hooks/useTasks";

interface TasksProps {
  agents: AgentEntry[];
  /** UUID of the workspace currently in scope (from the URL); null = no workspace. */
  currentWorkspaceId: string | null;
  /** Server-supplied config; null while still being fetched. */
  config: ServerConfig | null;
}

const DEFAULT_POLL_INTERVAL_MS = 4000;

/**
 * Tasks page — fire-and-forget agent dispatch, autonomous run,
 * polling detail view. Master-detail layout: a filtered + grouped
 * task list on the left, a tabbed detail panel on the right.
 *
 * This file is a thin shell — page-level data loading lives in
 * {@link useTasks}, per-task detail loading in `useTaskDetail`,
 * URL selection in {@link useSelectedTask}. Presentational pieces
 * live under `../components/tasks/`. The pre-mission-A version of
 * this file was 2377 lines.
 */
export function TasksPage({ agents, currentWorkspaceId, config }: TasksProps) {
  const pollIntervalMs = config?.tasks?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const { selectedId, setSelectedId } = useSelectedTask(currentWorkspaceId);
  const data = useTasks({ currentWorkspaceId, pollIntervalMs });
  const {
    tasks,
    runtimes,
    loaded,
    refreshing,
    error,
    setError,
    agentFilter,
    setAgentFilter,
    runtimeFilter,
    setRuntimeFilter,
    timeFilter,
    setTimeFilter,
    originFilter,
    setOriginFilter,
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

  const visibleTasks = useMemo(() => {
    const q = idQuery.trim().toLowerCase();
    if (q === "") return tasks;
    return tasks.filter((t) => t.id.toLowerCase().includes(q));
  }, [tasks, idQuery]);

  // Drop URL-bound selection if the task is truly gone (deleted
  // server-side, or never existed when navigating to a stale link).
  useEffect(() => {
    if (!loaded) return;
    if (selectedId !== null && !tasks.some((t) => t.id === selectedId)) {
      setSelectedId(null);
    }
  }, [loaded, selectedId, tasks, setSelectedId]);

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
      <div className="page-toolbar page-toolbar--tasks">
        <div className="page-toolbar__actions">
          <TasksToolbar
            refreshing={refreshing}
            onRefresh={refresh}
            dispatchDisabled={readyAgents.length === 0}
            dispatchDisabledTitle={
              readyAgents.length === 0
                ? "Install at least one ready agent in the Catalog first"
                : "Dispatch a new task"
            }
            onDispatch={() => setDispatchOpen(true)}
          />
        </div>
      </div>

      {error && <div className="alert alert--error">⚠️ {error}</div>}

      <div
        className={`tasks-pane${selectedId ? " tasks-pane--with-detail" : " tasks-pane--list-only"}`}
      >
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
            originFilter={originFilter}
            onOriginFilterChange={setOriginFilter}
            agents={agents}
            filterAgentNames={filterAgentNames}
            runtimes={runtimes}
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
              />
            )}
          </div>
        </div>

        {selectedId && (
          <TaskDetail
            taskId={selectedId}
            onClose={() => setSelectedId(null)}
            onCancel={requestCancel}
            onRequestDelete={setDeleteTarget}
            pollIntervalMs={pollIntervalMs}
          />
        )}
      </div>

      <DispatchModal
        open={dispatchOpen}
        agents={readyAgents}
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
