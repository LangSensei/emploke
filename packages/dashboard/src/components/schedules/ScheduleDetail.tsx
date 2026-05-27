import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getSchedule,
  patchSchedule,
  previewSchedule,
  runSchedule,
  type ScheduleDetail as ScheduleDetailType,
  type SchedulePreview,
} from "../../api";
import { formatAbsolute, formatRelative } from "../../utils/time";
import { ScheduleRecentFires } from "./ScheduleRecentFires";

export interface ScheduleDetailProps {
  scheduleId: string;
  currentWorkspaceId: string;
  /** Bumped by the parent after a successful list mutation (e.g. delete) so we re-fetch. */
  refreshToken: number;
  onPatched: (next: ScheduleDetailType) => void;
  onRequestDelete: (target: ScheduleDetailType) => void;
}

const PREVIEW_COUNT = 3;

/**
 * Right-pane detail view for a single schedule.
 *
 * Header: name (h2), cron expression (mono code badge), tz, the
 * server-computed describe, next-N fire times via `previewSchedule`,
 * Enabled toggle (optimistic patch with rollback), Run-now button
 * (deep-links to the new task), Delete (opens confirm modal).
 *
 * The next-fire preview is fetched on schedule change and on each
 * successful patch (in case the trigger changed) — currently the
 * only patch surfaced by the UI is the enabled toggle (cron edits
 * stay CLI-only in v1), but the preview is still re-fetched because
 * the `nextFireAt` advances as time passes and a re-fetch keeps the
 * tooltip honest.
 */
export function ScheduleDetail({
  scheduleId,
  currentWorkspaceId,
  refreshToken,
  onPatched,
  onRequestDelete,
}: ScheduleDetailProps) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<ScheduleDetailType | null>(null);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"toggle" | "run" | null>(null);
  const [recentRefresh, setRecentRefresh] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Fetch detail + preview together so the header always renders with
  // a consistent describe / next-fire pair.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is intentionally part of the re-fetch trigger set; parent bumps it after delete to reseed the surface
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDetail(null);
    setPreview(null);
    void Promise.all([
      getSchedule(scheduleId),
      previewSchedule(scheduleId, { n: PREVIEW_COUNT }).catch((e: unknown) => e),
    ]).then(
      ([d, p]) => {
        if (cancelled) return;
        setDetail(d);
        if (p instanceof Error) {
          // Preview failure is non-fatal — the detail header still renders;
          // we just hide the next-fire list and surface a small note.
          setPreview({ describe: d.describe, nextRuns: [] });
        } else {
          setPreview(p as SchedulePreview);
        }
      },
      (e: unknown) => {
        if (cancelled) return;
        setError((e as Error).message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scheduleId, refreshToken]);

  const reloadPreview = useCallback(() => {
    previewSchedule(scheduleId, { n: PREVIEW_COUNT })
      .then((p) => {
        if (mounted.current) setPreview(p);
      })
      .catch(() => {
        /* keep the previous preview; the error already shows in the header */
      });
  }, [scheduleId]);

  const handleToggleEnabled = useCallback(async () => {
    if (!detail || busyAction !== null) return;
    const previous = detail;
    const next = { ...detail, enabled: !detail.enabled };
    setDetail(next);
    setBusyAction("toggle");
    setError(null);
    try {
      const updated = await patchSchedule(scheduleId, { enabled: !previous.enabled });
      if (!mounted.current) return;
      // Server doesn't return describe on PATCH — keep the previous one.
      const merged: ScheduleDetailType = { ...updated, describe: previous.describe };
      setDetail(merged);
      onPatched(merged);
      reloadPreview();
    } catch (e) {
      if (!mounted.current) return;
      setDetail(previous);
      setError((e as Error).message);
    } finally {
      if (mounted.current) setBusyAction(null);
    }
  }, [detail, busyAction, scheduleId, onPatched, reloadPreview]);

  const handleRunNow = useCallback(async () => {
    if (!detail || busyAction !== null) return;
    setBusyAction("run");
    setError(null);
    try {
      const { taskId } = await runSchedule(scheduleId);
      if (!mounted.current) return;
      setRecentRefresh((n) => n + 1);
      navigate(
        `/workspaces/${encodeURIComponent(currentWorkspaceId)}/runtime/tasks?taskId=${encodeURIComponent(taskId)}`,
      );
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message);
    } finally {
      if (mounted.current) setBusyAction(null);
    }
  }, [detail, busyAction, scheduleId, currentWorkspaceId, navigate]);

  if (error && detail === null) {
    return (
      <aside className="tasks-pane__detail">
        <div className="alert alert--error">⚠️ {error}</div>
      </aside>
    );
  }
  if (detail === null) {
    return (
      <aside className="tasks-pane__detail">
        <p className="muted" style={{ padding: 16 }}>
          Loading…
        </p>
      </aside>
    );
  }

  return (
    <aside className="tasks-pane__detail schedule-detail">
      {error && (
        <div className="alert alert--error" style={{ margin: "0 0 12px 0" }}>
          ⚠️ {error}
        </div>
      )}
      <header className="task-detail__head" style={{ flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{detail.name}</h2>
          <span
            className={`badge ${
              detail.enabled ? "badge--success" : "badge--muted"
            } badge--with-dot`}
          >
            <span className="badge__dot" aria-hidden="true" />
            {detail.enabled ? "Enabled" : "Paused"}
          </span>
        </div>
        <div className="task-list__item-meta muted">
          <code title={`Cron expression in ${detail.trigger.tz}`}>{detail.trigger.expr}</code>
          <span className="task-list__sep">·</span>
          <span>{detail.trigger.tz}</span>
          <span className="task-list__sep">·</span>
          <span title="cronstrue (zh_CN, server-rendered)">{detail.describe}</span>
        </div>
        <div className="task-list__item-meta muted">
          <span>
            Agent: <strong style={{ fontWeight: 600 }}>{detail.target.agent}</strong>
          </span>
          {detail.target.runtime ? (
            <>
              <span className="task-list__sep">·</span>
              <span>Runtime: {detail.target.runtime}</span>
            </>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <button
            type="button"
            className={`btn ${detail.enabled ? "btn--ghost" : "btn--primary"}`}
            onClick={() => void handleToggleEnabled()}
            disabled={busyAction !== null}
            aria-pressed={detail.enabled}
            data-testid="schedule-detail-toggle"
          >
            {busyAction === "toggle"
              ? detail.enabled
                ? "Pausing…"
                : "Resuming…"
              : detail.enabled
                ? "Pause"
                : "Resume"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void handleRunNow()}
            disabled={busyAction !== null || !detail.enabled}
            title={detail.enabled ? "Trigger one immediate run" : "Resume to enable Run now"}
            data-testid="schedule-detail-run-now"
          >
            {busyAction === "run" ? "Dispatching…" : "Run now"}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => onRequestDelete(detail)}
            disabled={busyAction !== null}
            data-testid="schedule-detail-delete"
          >
            Delete
          </button>
        </div>
      </header>

      <div
        className="task-detail__body"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <section aria-label="Next fires">
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px 0" }}>
            Next {PREVIEW_COUNT} fires
          </h3>
          {preview === null ? (
            <p className="muted" style={{ fontSize: 12 }}>
              Loading…
            </p>
          ) : preview.nextRuns.length === 0 ? (
            <p className="muted" style={{ fontSize: 12 }}>
              No upcoming fires (the schedule may be paused or the cron expression yielded nothing).
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {preview.nextRuns.map((iso) => (
                <li key={iso} style={{ fontSize: 13, padding: "2px 0" }}>
                  <span title={formatAbsolute(iso)}>{formatRelative(iso)}</span>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    ({formatAbsolute(iso)})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Instructions">
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px 0" }}>Instructions</h3>
          <p
            className="muted"
            style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.45, margin: 0 }}
          >
            {detail.target.instructions}
          </p>
        </section>

        <ScheduleRecentFires
          scheduleId={scheduleId}
          currentWorkspaceId={currentWorkspaceId}
          refreshToken={recentRefresh}
        />
      </div>
    </aside>
  );
}
