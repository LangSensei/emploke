import type { AgentEntry } from "@emploke/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cancelTask, deleteTask, dispatchTask, type ServerConfig, type TaskRecord } from "../api";
import { HeaderActions } from "../components/HeaderActions";
import { LegacyMovedBanner } from "../components/LegacyMovedBanner";
import { DispatchModal } from "../components/tasks/DispatchModal";
import {
  ALL_AGENTS,
  ALL_RUNTIMES,
  TIME_PRESETS,
  type TimePreset,
} from "../components/tasks/shared";
import { TaskConfirmModalsHost } from "../components/tasks/TaskConfirmModals";
import { TaskDetail } from "../components/tasks/TaskDetail";
import { TaskFilters } from "../components/tasks/TaskFilters";
import { TaskList } from "../components/tasks/TaskList";
import {
  TaskDetailPlaceholder,
  TasksEmptyState,
  TasksToolbar,
  TasksZeroState,
} from "../components/tasks/TasksChrome";
import { useMounted } from "../hooks/useMounted";
import { useSelectedTask } from "../hooks/useSelectedTask";
import { useTasks } from "../hooks/useTasks";
import { useUrlSearchValue } from "../hooks/useUrlState";

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

function coerceTimePreset(raw: string): TimePreset {
  const match = TIME_PRESETS.find((p) => p.value === raw);
  return match ? match.value : DEFAULT_TIME_PRESET;
}

/**
 * Tasks page — fire-and-forget agent dispatch, autonomous run,
 * polling detail view. Master-detail layout: a filtered + grouped
 * task list on the left, a tabbed detail panel on the right.
 *
 * Phase 1.5 Block G — every filter (`?agent`, `?runtime`, `?range`,
 * `?q`) plus the master-detail selection (`?taskId`) is URL-driven
 * via {@link useUrlSearchValue}, so refresh / back-button / shared
 * link all reproduce the same view. A legacy `?status=` slot lingers
 * in old links; it is ignored gracefully (no read, no redirect).
 */
export function TasksPage({ agents, currentWorkspaceId, config, fixedAgentFqn }: TasksProps) {
  const pollIntervalMs = config?.tasks?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // URL-driven filter state. fixedAgentFqn (per-agent embed) takes
  // precedence over the URL `?agent=` slot.
  const [idQuery, setIdQuery] = useUrlSearchValue("q", "");
  const [agentFilterUrl, setAgentFilterUrl] = useUrlSearchValue("agent", ALL_AGENTS);
  const [runtimeFilter, setRuntimeFilter] = useUrlSearchValue("runtime", ALL_RUNTIMES);
  const [rangeUrl, setRangeUrl] = useUrlSearchValue("range", DEFAULT_TIME_PRESET);

  const agentFilter = fixedAgentFqn ?? agentFilterUrl;
  const setAgentFilter = fixedAgentFqn ? () => {} : setAgentFilterUrl;
  const timeFilter = coerceTimePreset(rangeUrl);
  const setTimeFilter = (v: TimePreset) => setRangeUrl(v);

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

  // Legacy `?dispatch=1` deep-link reader (Phase 1.5 §4.3 → PR #189
  // polish v3 in-place modals). The agent-detail "+ New task" button
  // now mounts DispatchModal locally on AgentDetailPane and no longer
  // navigates here, so nothing in-app writes this flag any more — the
  // reader stays so pre-v3 bookmarks (`?dispatch=1&agent=<fqn>`) and
  // externally-pasted URLs still open the modal on landing. The flag
  // is stripped after consumption so a refresh/back doesn't re-open
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

  const mounted = useMounted();

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
      if (!mounted.current) return;
      setDispatchOpen(false);
      setRerunFrom(null);
      setSelectedId(created.id);
      await refresh();
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const onConfirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setError(null);
    try {
      await deleteTask(deleteTarget.id, { purge: deletePurge });
      if (!mounted.current) return;
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
      setDeletePurge(false);
      await refresh();
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
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
      if (!mounted.current) return;
      setCancelTarget(null);
      await refresh();
    } catch (e) {
      if (!mounted.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      // 409 = already terminal; benign race — next refresh re-syncs.
      if (/409/.test(msg)) {
        setCancelTarget(null);
        await refresh();
        return;
      }
      setCancelError(msg);
    } finally {
      if (mounted.current) setCancelBusy(false);
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
      return true;
    });
  }, [tasks, idQuery]);

  // Phase A default-selection rule: auto-bind to the top-most visible
  // task when the URL doesn't already pin one with `?taskId=` and the
  // list is non-empty. Derived during render so it doesn't race the
  // URL-clearing path (Phase 1.5 Block G — earlier auto-select-via-
  // effect would silently re-introduce filter params it captured in a
  // stale closure).
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

  // PR #189 polish v3 — true when any filter chrome is constraining the
  // list. Used by the zero-state collapse: when the workspace returns
  // zero tasks AND no filter is active, we collapse to a single
  // full-width empty (Dispatch CTA); when a filter IS active we keep
  // the split layout so the user can see and clear the filter chrome.
  // `fixedAgentFqn` (per-agent embed) is NOT a user-set filter for this
  // purpose — those embeds don't surface clear-filter affordances.
  const filtersActive =
    idQuery.trim() !== "" ||
    (!fixedAgentFqn && agentFilterUrl !== ALL_AGENTS) ||
    runtimeFilter !== ALL_RUNTIMES ||
    timeFilter !== DEFAULT_TIME_PRESET;

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

        {/* PR #189 polish v3 — when the workspace has zero tasks AND no
            user-set filter is hiding rows, collapse the split layout into
            a single full-width zero-state with a Dispatch-task CTA. The
            previous shape rendered both the list-side empty AND the
            right-pane "No task selected" placeholder side-by-side, which
            left a wide gap of empty space between two near-identical
            cards. See
            `.pilot/inbox/20260525-empty-state-double-render.md`.
            When ANY filter is active (`?agent=`, `?runtime=`, `?q=`,
            or a non-default time preset) we keep the split layout so
            the user can see the filter chrome and clear it. */}
        {loaded && tasks.length === 0 && !filtersActive ? (
          <div className="tasks-pane tasks-pane--with-detail tasks-pane--zero">
            <TasksZeroState
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
          </div>
        ) : (
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
                    title="No matches"
                    hint="Adjust the filters above to see more tasks."
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
            ) : visibleTasks.length === 0 ? null : (
              // PR #189 polish v4 — when the filter narrowed the list
              // to zero rows the left card already carries the full
              // "No matches" copy; rendering the detail-side
              // "No task selected / No tasks match the current filters"
              // placeholder next to it produced two redundant empty
              // states. We only fall through to the placeholder when
              // there ARE visible rows but selection is null (in
              // practice rare because `effectiveSelectedId` auto-binds
              // to the first row, but we keep the branch for safety).
              // See `.pilot/inbox/20260525-v4-tasks-empty-state-filtered.md`.
              <TaskDetailPlaceholder />
            )}
          </div>
        )}
      </div>

      <DispatchModal
        open={dispatchOpen}
        agents={dispatchAgents}
        runtimes={runtimes}
        busy={busy}
        prefill={rerunFrom}
        // PR #189 polish v3 — seed the modal with the page's current
        // agent context when a single agent is pinned via `?agent=`.
        // "All" keeps the existing `agents[0]` fallback; `prefill`
        // (re-run case) still wins over `initialAgent`.
        initialAgent={fixedAgentFqn ?? (agentFilterUrl !== ALL_AGENTS ? agentFilterUrl : undefined)}
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
