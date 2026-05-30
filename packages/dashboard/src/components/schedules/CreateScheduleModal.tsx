import type { AgentEntry } from "@emploke/catalog";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  type CreateScheduleBody,
  createSchedule,
  previewCron,
  type SchedulePreview,
  type ScheduleView,
} from "../../api";
import { Modal } from "../Modal";
import { type Preset, presetToCron, validatePreset } from "./cronPresets";
import { PresetEditor } from "./PresetEditor";
import { browserTimezone, buildTimezoneOptions } from "./scheduleFormShared";

export interface CreateScheduleModalProps {
  open: boolean;
  agents: AgentEntry[];
  runtimes: string[];
  /** Timezones already present on the workspace's existing schedules. Modal dedupes against UTC + browser local. */
  existingTimezones: string[];
  onClose: () => void;
  onCreated: (s: ScheduleView) => void;
}

const PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_COUNT = 5;

/**
 * "New schedule" modal — issue #222.
 *
 * Preset-driven cron builder with a server-rendered live preview
 * (debounced 300ms). All seven presets feed a single read-only cron
 * chip + the preview region; the Advanced preset lets users type
 * arbitrary cron expressions for the long tail (`*\/5 9-17 * * 1-5`
 * is the canonical example).
 *
 * Stale-response protection: the debounced preview effect owns a
 * per-call `AbortController` whose `.abort()` runs in the cleanup
 * function. This both cancels the in-flight `fetch` at the network
 * layer (no wasted server work on every keystroke) and short-circuits
 * the `.then`/`.catch` handlers via the `signal.aborted` check, so a
 * slow request kicked off at edit T1 cannot resolve after a fast one
 * kicked off at T2 and clobber the newer preview.
 *
 * Local validation gates the network round-trip: empty advanced expr,
 * weekly with zero days selected, etc. all short-circuit before the
 * fetch — no point pinging the server with known-bad inputs.
 *
 * Error-body preservation: `previewCron` and `createSchedule` both
 * surface the server's `error` string verbatim (via the shared
 * `extractError`-based helper in `api.ts`), so users see "Invalid
 * cron expression: …" rather than "schedule preview: 400". See
 * api.ts `fetchJsonWithErrorBody` for the seam.
 */
export function CreateScheduleModal({
  open,
  agents,
  runtimes,
  existingTimezones,
  onClose,
  onCreated,
}: CreateScheduleModalProps) {
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("");
  const [runtime, setRuntime] = useState("");
  const [brief, setBrief] = useState("");
  const [details, setDetails] = useState("");
  // Disabled today (only `task` exists). Kept as state for forward
  // compatibility — once `workflow` lands, we add a setter and unlock
  // the <select>. Keep this prop so future commits don't have to
  // re-introduce the discriminator-of-the-union state.
  const [targetKind] = useState<"task">("task");
  const [preset, setPreset] = useState<Preset>({ kind: "daily", hour: 9, minute: 0 });
  const [tz, setTz] = useState<string>(() => browserTimezone());
  const [enabled, setEnabled] = useState(true);

  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Mount-effect agent preselection (mirrors CreateModal.tsx lines 49-62).
  // Re-runs each time the modal opens or the agents list changes so
  // re-opening with a fresh agent list reseeds the dropdown.
  useEffect(() => {
    if (!open) return;
    setAgent(agents[0]?.agent.fqn ?? "");
  }, [open, agents]);

  // Default runtime to the first registered kind (matches CreateModal).
  // Empty runtime is a valid submit — server picks its default.
  useEffect(() => {
    if (open && runtimes.length > 0 && !runtimes.includes(runtime)) {
      setRuntime(runtimes[0] ?? "");
    }
  }, [open, runtimes, runtime]);

  // Reseed the timezone on open in case the browser tz changed since
  // the last open (e.g. the user changed laptop tz between modal
  // opens). Cheap idempotent — no-op when the value is already right.
  useEffect(() => {
    if (open) {
      setTz((current) => current || browserTimezone());
    }
  }, [open]);

  const tzOptions = useMemo(() => buildTimezoneOptions(existingTimezones), [existingTimezones]);

  // Derived cron + preset validation. Both flow through to the
  // preview-fetch effect and the submit-disable gate.
  const expr = useMemo(() => presetToCron(preset), [preset]);
  const presetError = useMemo(() => validatePreset(preset), [preset]);

  // Debounced preview fetch. Cleanup pattern uses a per-effect
  // `AbortController` so a stale response from a slow earlier
  // request cannot overwrite a newer preview AND the underlying
  // `fetch` is cancelled at the network layer (no wasted server
  // work on every keystroke). Short-circuits on local validation
  // failures and on tz === "" so we don't spam the server with
  // known-bad inputs.
  useEffect(() => {
    if (!open) return;
    if (presetError !== null) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    if (tz === "") {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setPreviewLoading(true);
    const handle = setTimeout(() => {
      previewCron({ expr, tz, n: PREVIEW_COUNT }, ctrl.signal)
        .then((p) => {
          if (ctrl.signal.aborted) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          // `AbortError` is the expected reject path when the effect
          // cleanup runs `ctrl.abort()`; silently swallow it so the
          // modal doesn't flash a misleading "preview failed" on
          // every keystroke.
          if ((e as { name?: string }).name === "AbortError") return;
          if (ctrl.signal.aborted) return;
          setPreview(null);
          setPreviewError((e as Error).message);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setPreviewLoading(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [open, expr, tz, presetError]);

  // Reset transient state on close so a re-open starts clean. Persist
  // the form fields themselves — re-opening immediately after closing
  // shouldn't drop the user's half-typed brief/details.
  useEffect(() => {
    if (!open) {
      setSubmitError(null);
      setSubmitting(false);
    }
  }, [open]);

  const canSubmit =
    !submitting &&
    name.trim() !== "" &&
    agent !== "" &&
    brief.trim() !== "" &&
    brief.trim().length <= 200 &&
    !brief.includes("\n") &&
    !brief.includes("\r") &&
    presetError === null &&
    previewError === null;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body: CreateScheduleBody = {
        name: name.trim(),
        target: {
          agent,
          brief: brief.trim(),
          ...(details.trim() ? { details: details.trim() } : {}),
          ...(runtime ? { runtime } : {}),
        },
        trigger: { kind: "cron", expr, tz },
        enabled,
      };
      const created = await createSchedule(body);
      onCreated(created);
      onClose();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New schedule" size="large">
      <form onSubmit={onSubmit} data-testid="create-schedule-form">
        <div className="modal__body">
          <label htmlFor="new-schedule-name">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Name
            </div>
            <input
              id="new-schedule-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              placeholder="Weekday morning summary"
              className="input"
              style={{ width: "100%" }}
              required
              data-testid="create-schedule-name"
            />
          </label>

          <label htmlFor="new-schedule-agent">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Agent
            </div>
            <select
              id="new-schedule-agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              disabled={submitting || agents.length === 0}
              required
              className="select select--full"
              data-testid="create-schedule-agent"
            >
              {agents.length === 0 ? (
                <option value="">(no installed agents)</option>
              ) : (
                agents.map((a) => (
                  <option key={a.agent.fqn} value={a.agent.fqn}>
                    {a.agent.fqn}
                  </option>
                ))
              )}
            </select>
          </label>

          <label htmlFor="new-schedule-runtime">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Runtime
            </div>
            <select
              id="new-schedule-runtime"
              value={runtime}
              onChange={(e) => setRuntime(e.target.value)}
              disabled={submitting || runtimes.length === 0}
              className="select select--full"
              data-testid="create-schedule-runtime"
            >
              {runtimes.length === 0 ? (
                <option value="">(server default)</option>
              ) : (
                runtimes.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))
              )}
            </select>
          </label>

          <label htmlFor="new-schedule-target-kind">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Target type
            </div>
            <select
              id="new-schedule-target-kind"
              value={targetKind}
              disabled
              className="select select--full"
              data-testid="create-schedule-target-kind"
            >
              <option value="task">Task</option>
            </select>
          </label>

          <label htmlFor="new-schedule-brief">
            <div
              className="muted"
              style={{
                fontSize: 12,
                marginBottom: 4,
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>Brief</span>
              <span
                className={brief.length > 200 ? "error" : "muted"}
                style={{ fontSize: 11 }}
                data-testid="create-schedule-brief-counter"
              >
                {brief.length}/200
              </span>
            </div>
            <input
              id="new-schedule-brief"
              type="text"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              disabled={submitting}
              placeholder="One-line summary the task list will show (e.g. Refresh weekday digest)"
              maxLength={200}
              className="input"
              style={{ width: "100%" }}
              required
              data-testid="create-schedule-brief"
            />
          </label>

          <label htmlFor="new-schedule-details">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Details (optional)
            </div>
            <textarea
              id="new-schedule-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              disabled={submitting}
              placeholder="Full instructions the agent will receive on each fire. Markdown OK."
              rows={4}
              className="input"
              style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
              data-testid="create-schedule-details"
            />
          </label>

          <PresetEditor preset={preset} onChange={setPreset} disabled={submitting} />

          <label htmlFor="new-schedule-tz">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Timezone
            </div>
            <select
              id="new-schedule-tz"
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              disabled={submitting}
              className="select select--full"
              data-testid="create-schedule-tz"
            >
              {tzOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <label
            htmlFor="new-schedule-enabled"
            style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}
          >
            <input
              id="new-schedule-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={submitting}
              data-testid="create-schedule-enabled"
            />
            <span>Start enabled (will fire automatically on schedule)</span>
          </label>

          <section
            aria-label="Preview"
            data-testid="create-schedule-preview"
            style={{
              border: "1px solid var(--border, #e0e0e0)",
              borderRadius: 4,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 12 }}>
                Cron
              </span>
              <code
                className="schedule-cron"
                title={`Cron expression in ${tz}`}
                data-testid="create-schedule-cron-chip"
              >
                {expr}
              </code>
            </div>
            {presetError !== null ? (
              <p
                className="muted"
                style={{ fontSize: 12, margin: 0 }}
                data-testid="create-schedule-preset-error"
              >
                {presetError}
              </p>
            ) : previewError !== null ? (
              <p
                className="alert alert--error"
                style={{ fontSize: 12, margin: 0 }}
                data-testid="create-schedule-preview-error"
              >
                ⚠️ {previewError}
              </p>
            ) : previewLoading ? (
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                Loading preview…
              </p>
            ) : preview === null ? (
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                Preview will appear here.
              </p>
            ) : (
              <>
                <p
                  className="muted"
                  style={{ fontSize: 12, margin: 0 }}
                  data-testid="create-schedule-preview-describe"
                >
                  {preview.describe}
                </p>
                <ul
                  style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}
                  data-testid="create-schedule-preview-next"
                >
                  {preview.nextRuns.map((iso) => (
                    <li key={iso}>{iso}</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {submitError !== null && (
            <div
              className="alert alert--error"
              style={{ marginTop: 8 }}
              data-testid="create-schedule-submit-error"
            >
              ⚠️ {submitError}
            </div>
          )}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!canSubmit}
            data-testid="create-schedule-submit"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
