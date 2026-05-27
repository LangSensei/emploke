import type { AgentEntry } from "@emploke/catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteSchedule,
  listSchedules,
  type ScheduleDetail as ScheduleDetailType,
  type ScheduleView,
} from "../api";
import { DeleteScheduleModal } from "../components/schedules/ScheduleConfirmModals";
import { ScheduleDetail } from "../components/schedules/ScheduleDetail";
import { ScheduleList } from "../components/schedules/ScheduleList";
import { SchedulesFilters } from "../components/schedules/SchedulesFilters";
import {
  ALL_AGENTS,
  ALL_ENABLED,
  type EnabledFilter,
  sortByNextFire,
} from "../components/schedules/shared";
import { useUrlSearchValue } from "../hooks/useUrlState";

export interface SchedulesPageProps {
  agents: AgentEntry[];
  /** UUID of the workspace currently in scope (from the URL); null = no workspace. */
  currentWorkspaceId: string | null;
}

/**
 * Schedules page (PR 4/4 of #61) — workspace-scoped cron-trigger
 * surface. Master-detail: filtered list on the left, detail panel on
 * the right driven by `?scheduleId=` in the URL.
 *
 * Per the #61 RFC, schedule creation + cron / instructions edits
 * stay CLI-only in v1; the dashboard surfaces the enable toggle,
 * Run-now, and Delete only.
 *
 * URL-driven filters (mirrors Tasks page pattern, Phase 1.5 Block G):
 *
 *   - `?agent=<fqn>` — agent filter
 *   - `?enabled=true|false` — enabled-state filter
 *   - `?scheduleId=<sid>` — master-detail selection
 */
export function SchedulesPage({ agents, currentWorkspaceId }: SchedulesPageProps) {
  const [agentFilter, setAgentFilter] = useUrlSearchValue("agent", ALL_AGENTS);
  const [enabledFilterRaw, setEnabledFilterRaw] = useUrlSearchValue("enabled", ALL_ENABLED);
  const [selectedIdRaw, setSelectedIdRaw] = useUrlSearchValue("scheduleId", "");

  const enabledFilter = coerceEnabledFilter(enabledFilterRaw);
  const setEnabledFilter = (v: EnabledFilter) => setEnabledFilterRaw(v);
  const selectedId = selectedIdRaw === "" ? null : selectedIdRaw;
  const setSelectedId = useCallback(
    (id: string | null) => setSelectedIdRaw(id ?? ""),
    [setSelectedIdRaw],
  );

  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const [deleteTarget, setDeleteTarget] = useState<ScheduleDetailType | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!currentWorkspaceId) {
      setSchedules([]);
      setLoaded(true);
      return;
    }
    try {
      const opts: Parameters<typeof listSchedules>[0] = {};
      if (agentFilter !== ALL_AGENTS) opts.agent = agentFilter;
      if (enabledFilter !== ALL_ENABLED) opts.enabled = enabledFilter === "true";
      const next = await listSchedules(opts);
      if (!mounted.current) return;
      setSchedules(sortByNextFire(next));
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message);
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, [currentWorkspaceId, agentFilter, enabledFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Iter-2 F1 parity with Tasks: re-fetch when the tab becomes visible
  // again so stale data doesn't linger after long inactivity.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  const visible = schedules;

  const filterAgentNames = useMemo(() => {
    const set = new Set<string>(agents.map((a) => a.agent.fqn));
    for (const s of schedules) set.add(s.target.agent);
    return Array.from(set).sort();
  }, [agents, schedules]);

  // Phase A default-selection rule (mirror of TasksPage): auto-bind
  // to the top-most visible row when the URL doesn't pin one. Derived
  // during render so it doesn't race the URL-clearing path.
  const effectiveSelectedId =
    selectedId !== null && visible.some((s) => s.id === selectedId)
      ? selectedId
      : loaded && visible.length > 0
        ? visible[0]!.id
        : null;

  const handlePatched = useCallback((updated: ScheduleDetailType) => {
    setSchedules((prev) =>
      sortByNextFire(prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s))),
    );
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteSchedule(deleteTarget.id);
      if (!mounted.current) return;
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setSchedules((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      setDeleteTarget(null);
      setRefreshToken((n) => n + 1);
    } catch (e) {
      if (!mounted.current) return;
      setDeleteError((e as Error).message);
    } finally {
      if (mounted.current) setDeleteBusy(false);
    }
  }, [deleteTarget, selectedId, setSelectedId]);

  if (currentWorkspaceId === null) {
    return (
      <div className="alert alert--error">
        No workspace is selected. Use the workspace dropdown in the top bar to choose or create one
        — schedules are scoped to a workspace.
      </div>
    );
  }

  const filtersActive = agentFilter !== ALL_AGENTS || enabledFilter !== ALL_ENABLED;

  return (
    <>
      <div className="tasks-page">
        {error && <div className="alert alert--error">⚠️ {error}</div>}
        {loaded && schedules.length === 0 && !filtersActive ? (
          <div className="tasks-pane tasks-pane--with-detail tasks-pane--zero">
            <div className="empty tasks-pane__zero" data-testid="schedules-empty-zero">
              <div className="empty__icon" aria-hidden="true">
                📅
              </div>
              <p className="empty__title">No schedules yet</p>
              <p className="empty__hint">
                Create one from the CLI with <code>emploke schedule create</code>; the dashboard
                will list it here. Create / edit UI is intentionally CLI-only in v1 (RFC #61).
              </p>
            </div>
          </div>
        ) : (
          <div className="tasks-pane tasks-pane--with-detail">
            <div className="tasks-pane__list">
              <SchedulesFilters
                agentFilter={agentFilter}
                onAgentFilterChange={setAgentFilter}
                enabledFilter={enabledFilter}
                onEnabledFilterChange={setEnabledFilter}
                agents={agents}
                filterAgentNames={filterAgentNames}
              />
              <div className="tasks-pane__list-scroll">
                {!loaded ? (
                  <div className="empty">
                    <p className="empty__title">Loading schedules…</p>
                  </div>
                ) : visible.length === 0 ? (
                  <div className="empty" data-testid="schedules-empty-filtered">
                    <p className="empty__title">No matches</p>
                    <p className="empty__hint">Adjust the filters above to see more schedules.</p>
                  </div>
                ) : (
                  <ScheduleList
                    schedules={visible}
                    selectedId={effectiveSelectedId}
                    onSelect={setSelectedId}
                  />
                )}
              </div>
            </div>

            {effectiveSelectedId ? (
              <ScheduleDetail
                key={effectiveSelectedId}
                scheduleId={effectiveSelectedId}
                currentWorkspaceId={currentWorkspaceId}
                refreshToken={refreshToken}
                onPatched={handlePatched}
                onRequestDelete={setDeleteTarget}
              />
            ) : visible.length === 0 ? null : (
              <aside className="tasks-pane__detail tasks-pane__detail--empty">
                <div className="empty">
                  <div className="empty__icon">📅</div>
                  <p className="empty__title">No schedule selected</p>
                </div>
              </aside>
            )}
          </div>
        )}
      </div>

      {deleteTarget && (
        <DeleteScheduleModal
          target={deleteTarget}
          busy={deleteBusy}
          error={deleteError}
          onClose={() => {
            if (deleteBusy) return;
            setDeleteTarget(null);
            setDeleteError(null);
          }}
          onConfirm={handleConfirmDelete}
        />
      )}
    </>
  );
}

function coerceEnabledFilter(raw: string): EnabledFilter {
  return raw === "true" || raw === "false" ? raw : ALL_ENABLED;
}
