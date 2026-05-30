import type { AgentEntry } from "@emploke/catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  deleteSchedule,
  listRuntimes,
  listSchedules,
  type ScheduleDetail as ScheduleDetailType,
  type ScheduleView,
  type ServerConfig,
} from "../api";
import { HeaderActions } from "../components/HeaderActions";
import { PlusIcon } from "../components/Icons";
import { CreateScheduleModal } from "../components/schedules/CreateScheduleModal";
import { EditScheduleModal } from "../components/schedules/EditScheduleModal";
import { FireTaskDetailPane } from "../components/schedules/FireTaskDetailPane";
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
  /**
   * Server-supplied config; null while still being fetched. Used to
   * source the Mode B per-task poll interval so the value matches the
   * Tasks page (`config.tasks.pollIntervalMs`) instead of drifting on
   * a Schedules-local constant.
   */
  config?: ServerConfig | null;
}

const DEFAULT_FIRE_TASK_POLL_INTERVAL_MS = 4000;

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
export function SchedulesPage({ agents, currentWorkspaceId, config }: SchedulesPageProps) {
  const fireTaskPollIntervalMs =
    config?.tasks?.pollIntervalMs ?? DEFAULT_FIRE_TASK_POLL_INTERVAL_MS;
  const navigate = useNavigate();
  const location = useLocation();
  const [agentFilter, setAgentFilter] = useUrlSearchValue("agent", ALL_AGENTS);
  const [enabledFilterRaw, setEnabledFilterRaw] = useUrlSearchValue("enabled", ALL_ENABLED);
  const [selectedIdRaw] = useUrlSearchValue("scheduleId", "");
  const [fireTaskIdRaw] = useUrlSearchValue("fireTaskId", "");

  const enabledFilter = coerceEnabledFilter(enabledFilterRaw);
  const setEnabledFilter = useCallback(
    (v: EnabledFilter) => setEnabledFilterRaw(v),
    [setEnabledFilterRaw],
  );
  const selectedId = selectedIdRaw === "" ? null : selectedIdRaw;
  const fireTaskId = fireTaskIdRaw === "" ? null : fireTaskIdRaw;

  // Atomic URL writer: updates `scheduleId` and `fireTaskId` in a
  // single `navigate()` call so two sequential single-key setters
  // can't race via stale `location.search` snapshots (see
  // hooks/useUrlState.ts — each setter captures `location.search` at
  // hook-call time, so two back-to-back setValue calls in the same
  // handler would both reseed from the same snapshot and the second
  // would overwrite the first). Pass `undefined` to leave a key
  // untouched, empty string to delete it.
  const setMasterDetailUrl = useCallback(
    (next: { scheduleId?: string | null; fireTaskId?: string | null }) => {
      const params = new URLSearchParams(location.search);
      if (next.scheduleId !== undefined) {
        if (next.scheduleId === null || next.scheduleId === "") params.delete("scheduleId");
        else params.set("scheduleId", next.scheduleId);
      }
      if (next.fireTaskId !== undefined) {
        if (next.fireTaskId === null || next.fireTaskId === "") params.delete("fireTaskId");
        else params.set("fireTaskId", next.fireTaskId);
      }
      const search = params.toString();
      navigate(`${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`, {
        replace: true,
      });
    },
    [navigate, location.pathname, location.search, location.hash],
  );

  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const [deleteTarget, setDeleteTarget] = useState<ScheduleDetailType | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Transient outcome banner shown after a successful delete so the
  // user sees the cascade count (parity with the CLI suffix
  // "schedule X removed (and N historical task(s))"). The dashboard
  // has no toast layer, so we render an `.alert--info` strip above
  // the page content and auto-clear it after a few seconds. Cleared
  // immediately when another delete starts so the user never sees
  // stale outcome text.
  const [deleteNotice, setDeleteNotice] = useState<{
    name: string;
    deletedTaskCount: number;
  } | null>(null);

  const [editTarget, setEditTarget] = useState<ScheduleDetailType | null>(null);

  // Issue #222 — "New schedule" modal state + supporting fetches.
  // `runtimes` is fetched here (mirroring Sessions.tsx) because
  // SchedulesPage doesn't currently receive it as a prop and the
  // modal needs the dropdown population.
  const [createOpen, setCreateOpen] = useState(false);
  const [runtimes, setRuntimes] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    listRuntimes()
      .then((list) => {
        if (!cancelled) setRuntimes(list.map((r) => r.kind));
      })
      .catch(() => {
        // Non-fatal: modal falls back to "(server default)" runtime option.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    // Bump so the detail pane re-fetches preview / recent-fires when
    // an Edit-modal patch lands; toggle/run-now don't need this since
    // ScheduleDetail does its own optimistic merge.
    setRefreshToken((n) => n + 1);
  }, []);

  // Close the Edit modal when the user switches to a different
  // schedule (URL flip clears the modal's target so it doesn't fight
  // ScheduleDetail's incoming new selection). Idempotent: no-op when
  // editTarget is already null.
  useEffect(() => {
    if (editTarget !== null && editTarget.id !== effectiveSelectedId) {
      setEditTarget(null);
    }
  }, [effectiveSelectedId, editTarget]);

  // Only honour `?fireTaskId=` when a schedule is actually selected.
  // Without this guard, a deep link with `?fireTaskId=` but no
  // `?scheduleId=` would render Mode B against a null schedule.
  const effectiveFireTaskId = effectiveSelectedId !== null ? fireTaskId : null;

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    // Clear any prior outcome notice so the user never sees stale text
    // while the new delete is in flight.
    setDeleteNotice(null);
    try {
      const { deletedTaskCount } = await deleteSchedule(deleteTarget.id);
      if (!mounted.current) return;
      if (selectedId === deleteTarget.id) {
        // Atomic clear so a stale fireTaskId can't outlive the
        // schedule it belonged to.
        setMasterDetailUrl({ scheduleId: null, fireTaskId: null });
      }
      setSchedules((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      setDeleteNotice({ name: deleteTarget.name, deletedTaskCount });
      setDeleteTarget(null);
      setRefreshToken((n) => n + 1);
    } catch (e) {
      if (!mounted.current) return;
      setDeleteError((e as Error).message);
    } finally {
      if (mounted.current) setDeleteBusy(false);
    }
  }, [deleteTarget, selectedId, setMasterDetailUrl]);

  // Auto-dismiss the post-delete outcome banner after ~6 seconds.
  // Long enough for the user to read it, short enough that it doesn't
  // linger across navigations.
  useEffect(() => {
    if (!deleteNotice) return;
    const t = setTimeout(() => {
      if (mounted.current) setDeleteNotice(null);
    }, 6000);
    return () => clearTimeout(t);
  }, [deleteNotice]);

  // Timezones already present on the workspace's existing schedules,
  // surfaced as quick-pick options in the modal's tz dropdown
  // (alongside browser-local and UTC). De-duplicated by the modal.
  const existingTimezones = useMemo(
    () => Array.from(new Set(schedules.map((s) => s.trigger.tz))),
    [schedules],
  );

  // Created-row handler for the "New schedule" modal. Optimistically
  // prepends the new row + selects it + bumps the refresh token so
  // the detail pane re-fetches with the server's authoritative copy
  // (including the `describe` enrichment the POST response lacks).
  //
  // Filter-reset rule: if the active filters would hide the new row,
  // reset them so the user isn't left staring at "row created but you
  // can't see it". Issue #222 acceptance criterion: "Successful
  // create: modal closes, new row appears in list, auto-selected in
  // detail pane."
  const handleCreated = useCallback(
    (created: ScheduleView) => {
      setSchedules((prev) => sortByNextFire([created, ...prev]));
      // Atomic write — clear any leftover fireTaskId from a prior
      // selection while moving to the newly-created row.
      setMasterDetailUrl({ scheduleId: created.id, fireTaskId: null });
      setRefreshToken((n) => n + 1);
      setCreateOpen(false);
      const hiddenByAgent = agentFilter !== ALL_AGENTS && created.target.agent !== agentFilter;
      const hiddenByEnabled =
        (enabledFilter === "true" && !created.enabled) ||
        (enabledFilter === "false" && created.enabled);
      if (hiddenByAgent) setAgentFilter(ALL_AGENTS);
      if (hiddenByEnabled) setEnabledFilter(ALL_ENABLED);
    },
    [agentFilter, enabledFilter, setMasterDetailUrl, setAgentFilter, setEnabledFilter],
  );

  // Selection-from-list handler: atomically updates `?scheduleId=`
  // and clears `?fireTaskId=` so leaving Mode B is implicit when you
  // pick a different schedule.
  const handleSelectSchedule = useCallback(
    (id: string | null) => {
      setMasterDetailUrl({ scheduleId: id, fireTaskId: null });
    },
    [setMasterDetailUrl],
  );

  // Mode-B entry handler — atomically writes the click target's
  // `fireTaskId` alongside the pinned `scheduleId`.
  const handleSelectFire = useCallback(
    (taskId: string) => {
      if (!effectiveSelectedId) return;
      setMasterDetailUrl({ scheduleId: effectiveSelectedId, fireTaskId: taskId });
    },
    [effectiveSelectedId, setMasterDetailUrl],
  );

  // Mode-B exit handler — drops `fireTaskId` only, keeps schedule.
  const handleBackFromFire = useCallback(() => {
    setMasterDetailUrl({ fireTaskId: null });
  }, [setMasterDetailUrl]);

  // Mode-B navigation — used by prev/next inside FireTaskDetailPane.
  const handleNavigateFire = useCallback(
    (nextTaskId: string) => {
      if (!effectiveSelectedId) return;
      setMasterDetailUrl({ scheduleId: effectiveSelectedId, fireTaskId: nextTaskId });
    },
    [effectiveSelectedId, setMasterDetailUrl],
  );

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
      <HeaderActions>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setCreateOpen(true)}
          disabled={agents.length === 0}
          title={
            agents.length === 0
              ? "Install at least one agent in the Catalog before creating schedules"
              : "Create a new schedule"
          }
          data-testid="schedules-new-cta"
        >
          <PlusIcon />
          <span>New schedule</span>
        </button>
      </HeaderActions>

      <div className="tasks-page">
        {error && <div className="alert alert--error">⚠️ {error}</div>}
        {deleteNotice && (
          <div
            className="alert alert--info"
            role="status"
            aria-live="polite"
            data-testid="schedules-delete-notice"
          >
            Schedule <code>{deleteNotice.name}</code> deleted
            {deleteNotice.deletedTaskCount > 0
              ? ` (${deleteNotice.deletedTaskCount} historical task ${
                  deleteNotice.deletedTaskCount === 1 ? "run" : "runs"
                } also removed).`
              : "."}
          </div>
        )}
        {loaded && schedules.length === 0 && !filtersActive ? (
          <div className="tasks-pane tasks-pane--with-detail tasks-pane--zero">
            <div className="empty tasks-pane__zero" data-testid="schedules-empty-zero">
              <div className="empty__icon" aria-hidden="true">
                📅
              </div>
              <p className="empty__title">No schedules yet</p>
              <p className="empty__hint">
                Get started by clicking the <strong>New schedule</strong> button above.
                Cron-expression editing of existing schedules stays CLI-only in v1 (
                <code>emploke schedule patch</code>).
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
                    onSelect={handleSelectSchedule}
                  />
                )}
              </div>
            </div>

            {effectiveSelectedId && effectiveFireTaskId ? (
              <FireTaskDetailPane
                key={effectiveSelectedId}
                scheduleId={effectiveSelectedId}
                scheduleName={visible.find((s) => s.id === effectiveSelectedId)?.name ?? "schedule"}
                fireTaskId={effectiveFireTaskId}
                pollIntervalMs={fireTaskPollIntervalMs}
                onBack={handleBackFromFire}
                onNavigate={handleNavigateFire}
              />
            ) : effectiveSelectedId ? (
              <ScheduleDetail
                key={effectiveSelectedId}
                scheduleId={effectiveSelectedId}
                currentWorkspaceId={currentWorkspaceId}
                refreshToken={refreshToken}
                onPatched={handlePatched}
                onRequestDelete={setDeleteTarget}
                onRequestEdit={setEditTarget}
                onSelectFire={handleSelectFire}
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

      {createOpen && (
        <CreateScheduleModal
          open={createOpen}
          agents={agents}
          runtimes={runtimes}
          existingTimezones={existingTimezones}
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      )}

      {editTarget && (
        <EditScheduleModal
          open={editTarget !== null}
          schedule={editTarget}
          agents={agents}
          runtimes={runtimes}
          existingTimezones={existingTimezones}
          onClose={() => setEditTarget(null)}
          onPatched={(next) => {
            handlePatched(next);
            setEditTarget(null);
          }}
        />
      )}
    </>
  );
}

function coerceEnabledFilter(raw: string): EnabledFilter {
  return raw === "true" || raw === "false" ? raw : ALL_ENABLED;
}
