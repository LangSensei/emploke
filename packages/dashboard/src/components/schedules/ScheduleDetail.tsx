import { useEffect, useState } from "react";
import {
  getSchedule,
  previewSchedule,
  type ScheduleDetail as ScheduleDetailType,
  type SchedulePreview,
} from "../../api";
import { formatAbsolute, formatRelative } from "../../utils/time";
import { ScheduleRecentFires } from "./ScheduleRecentFires";

export interface ScheduleDetailProps {
  scheduleId: string;
  currentWorkspaceId: string;
  /** Bumped by the parent after a successful list mutation (e.g. delete or row Pause/Resume) so we re-fetch the canonical detail + preview. */
  refreshToken: number;
  /** Bumped by the parent's row-level Run now success (only when the run targeted the currently-selected schedule) so the recent-fires panel re-fetches. */
  recentFiresToken: number;
  /**
   * Optimistic-enabled override sourced from the parent's list state.
   * Patches the one flag the parent can be authoritative about during
   * optimistic flips: when a row's Pause/Resume click flips the list
   * row's badge immediately, the detail pane's badge MUST flip in the
   * same frame — otherwise the same screen shows two contradictory
   * states for ~one network roundtrip (the detail pane's internal
   * `getSchedule(scheduleId)` re-fetch only runs after `refreshToken`
   * bumps, which the parent only bumps on patch success). The override
   * naturally rolls back when the parent rolls its list-state flip
   * back on patch failure. `undefined` means the parent has no
   * authoritative value yet (initial load); fall back to the
   * server-fetched `detail.enabled` in that case.
   */
  enabledOverride?: boolean;
  /** Swaps the right pane into Mode B (fire's task detail) via the parent's atomic URL writer. */
  onSelectFire: (taskId: string) => void;
}

const PREVIEW_COUNT = 1;

/**
 * Right-pane detail view for a single schedule.
 *
 * Header: two-column row — left side carries the schedule's identity
 * (name + enabled badge, cron expr + tz + describe, agent + runtime),
 * right side carries the temporal facts (next fire, last fired).
 *
 * Body: brief, optional details, recent fires. We do NOT render a
 * "Next N fires" list anymore — the single next-fire fact lives in
 * the header where users actually look for it, and the body stays
 * focused on "what is this schedule for" + "what has it produced".
 *
 * Row-level actions (Edit / Pause-Resume / Run-now / Delete) now live
 * exclusively in the list's per-row `⋯` menu (see `ScheduleListItem`).
 * The detail pane is the canonical *information* surface; the list is
 * the canonical *action* surface. The page-level
 * `refreshToken` / `recentFiresToken` props are the seams that keep
 * the detail in sync after a row mutation.
 *
 * The next-fire preview is fetched on schedule change and on each
 * page-driven `refreshToken` bump. We still ask the server for `n=1`
 * rather than computing locally because cron parsing + tz handling is
 * the server's job; the dashboard just renders.
 */
export function ScheduleDetail({
  scheduleId,
  currentWorkspaceId,
  refreshToken,
  recentFiresToken,
  enabledOverride,
  onSelectFire,
}: ScheduleDetailProps) {
  const [detail, setDetail] = useState<ScheduleDetailType | null>(null);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scheduleId, refreshToken]);

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
      <header className="task-detail__head schedule-detail__head">
        <div className="schedule-detail__head-row">
          <div className="schedule-detail__head-left">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{detail.name}</h2>
              {(() => {
                const displayEnabled = enabledOverride ?? detail.enabled;
                return (
                  <span
                    className={`badge ${
                      displayEnabled ? "badge--success" : "badge--warn"
                    } badge--with-dot`}
                  >
                    <span className="badge__dot" aria-hidden="true" />
                    {displayEnabled ? "Enabled" : "Paused"}
                  </span>
                );
              })()}
            </div>
            <div className="task-list__item-meta muted">
              <code className="schedule-cron" title={`Cron expression in ${detail.trigger.tz}`}>
                {detail.trigger.expr}
              </code>
              <span className="task-list__sep">·</span>
              <span>{detail.trigger.tz}</span>
              <span className="task-list__sep">·</span>
              <span title="cronstrue (server-rendered)">{detail.describe}</span>
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
          </div>
          <div className="schedule-detail__head-right" data-testid="schedule-detail-temporal">
            <ScheduleNextFire preview={preview} enabled={enabledOverride ?? detail.enabled} />
            <ScheduleLastFired lastFiredAt={detail.lastFiredAt} />
          </div>
        </div>
      </header>

      <div
        className="task-detail__body"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <section aria-label="Brief">
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px 0" }}>Brief</h3>
          <p
            className="muted"
            style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.45, margin: 0 }}
          >
            {detail.target.brief}
          </p>
        </section>

        {detail.target.details !== undefined && detail.target.details !== "" && (
          <section aria-label="Details">
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "12px 0 8px 0" }}>Details</h3>
            <p
              className="muted"
              style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.45, margin: 0 }}
            >
              {detail.target.details}
            </p>
          </section>
        )}

        <ScheduleRecentFires
          scheduleId={scheduleId}
          currentWorkspaceId={currentWorkspaceId}
          refreshToken={recentFiresToken}
          onSelectFire={onSelectFire}
        />
      </div>
    </aside>
  );
}

/**
 * Header right-column primitive — the single next-fire fact. Renders
 * a relative time ("in 5m") as primary with the absolute time as the
 * tooltip, mirroring the dashboard's "relative is the headline,
 * absolute is the proof" convention. When the schedule is paused or
 * the preview hasn't loaded yet, surfaces a one-line placeholder so
 * the right column never collapses to nothing (which would re-create
 * the empty-right-side imbalance the two-column header was added to
 * fix).
 */
function ScheduleNextFire({
  preview,
  enabled,
}: {
  preview: SchedulePreview | null;
  enabled: boolean;
}) {
  if (!enabled) {
    return (
      <div className="schedule-detail__temporal-line" data-testid="schedule-detail-next-fire">
        <span className="muted">Next fire</span> <strong>paused</strong>
      </div>
    );
  }
  if (preview === null) {
    return (
      <div className="schedule-detail__temporal-line" data-testid="schedule-detail-next-fire">
        <span className="muted">Next fire</span> <strong>…</strong>
      </div>
    );
  }
  const next = preview.nextRuns[0];
  if (next === undefined) {
    return (
      <div className="schedule-detail__temporal-line" data-testid="schedule-detail-next-fire">
        <span className="muted">Next fire</span> <strong>none upcoming</strong>
      </div>
    );
  }
  return (
    <div className="schedule-detail__temporal-line" data-testid="schedule-detail-next-fire">
      <span className="muted">Next fire</span>{" "}
      <strong title={formatAbsolute(next)}>{formatRelative(next)}</strong>
    </div>
  );
}

/**
 * Header right-column primitive — the last-fired fact. Mirrors
 * {@link ScheduleNextFire}'s layout so the two stack as a compact
 * "temporal facts" block. When the schedule has never fired we keep
 * the same line shape ("Last fired — never") rather than collapsing,
 * for the same right-column-balance reason.
 */
function ScheduleLastFired({ lastFiredAt }: { lastFiredAt: string | null | undefined }) {
  if (!lastFiredAt) {
    return (
      <div className="schedule-detail__temporal-line" data-testid="schedule-detail-last-fired">
        <span className="muted">Last fired</span> <strong>never</strong>
      </div>
    );
  }
  return (
    <div className="schedule-detail__temporal-line" data-testid="schedule-detail-last-fired">
      <span className="muted">Last fired</span>{" "}
      <strong title={formatAbsolute(lastFiredAt)}>{formatRelative(lastFiredAt)}</strong>
    </div>
  );
}
