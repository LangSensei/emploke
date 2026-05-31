import type { AgentEntry } from "@emploke/catalog";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  getSchedule,
  type PatchScheduleBody,
  patchSchedule,
  previewCron,
  type ScheduleDetail,
  type SchedulePreview,
} from "../../api";
import { Modal } from "../Modal";
import { type Preset, presetToCron, validatePreset } from "./cronPresets";
import { PresetEditor } from "./PresetEditor";
import { buildTimezoneOptions } from "./scheduleFormShared";
import { errorMessage, isAbortError } from "../../utils/errors";

export interface EditScheduleModalProps {
  open: boolean;
  schedule: ScheduleDetail;
  agents: AgentEntry[];
  runtimes: string[];
  /** Timezones already present on the workspace's existing schedules. */
  existingTimezones: string[];
  onClose: () => void;
  /**
   * Called after a successful PATCH with the freshly-built `ScheduleDetail`.
   * Re-uses {@link previewSchedule} to refresh `describe` when the trigger
   * changed; otherwise preserves the prior describe (no extra round-trip).
   */
  onPatched: (next: ScheduleDetail) => void;
}

const PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_COUNT = 5;

/**
 * Edit-schedule modal — issue #233 follow-up.
 *
 * Mirrors CreateScheduleModal's field layout and validation so users
 * see a familiar surface. Differences from Create:
 *
 *   - Initial preset is `{ kind: "advanced", expr }` so the existing
 *     cron expression is shown verbatim (no reverse-parser to a preset
 *     kind — too brittle for the gain).
 *   - No `enabled` toggle (ScheduleDetail's Pause/Resume already owns
 *     enabled-state; two surfaces for one boolean is a source of
 *     truth conflict).
 *   - Submit builds a sparse {@link PatchScheduleBody} via field-by-
 *     field diff (trim-before-compare) so the server only sees what
 *     actually changed. `target.details` / `target.runtime` use RFC
 *     7396 `null` when the user clears a previously-set value.
 *   - "No diff" disables submit so the button doesn't fire a meaningless
 *     PATCH.
 *
 * Layout / styling re-uses CreateScheduleModal's classes (label /
 * input / .modal__body / .modal__footer) directly — extracting a
 * shared `ScheduleFormFields` is out of scope for this PR since the
 * field set diverges (no enabled) and the diff logic is the only
 * non-trivial logic worth sharing (and we don't share it because each
 * modal owns its own submit verb).
 */
export function EditScheduleModal({
  open,
  schedule,
  agents,
  runtimes,
  existingTimezones,
  onClose,
  onPatched,
}: EditScheduleModalProps) {
  const initialDetails = schedule.target.details ?? "";
  const initialRuntime = schedule.target.runtime ?? "";

  const [name, setName] = useState(schedule.name);
  const [agent, setAgent] = useState(schedule.target.agent);
  const [runtime, setRuntime] = useState<string>(initialRuntime);
  const [brief, setBrief] = useState(schedule.target.brief);
  const [details, setDetails] = useState<string>(initialDetails);
  const [preset, setPreset] = useState<Preset>({
    kind: "advanced",
    expr: schedule.trigger.expr,
  });
  const [tz, setTz] = useState<string>(schedule.trigger.tz);

  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reseed all fields whenever the modal opens or the underlying
  // schedule changes (parent may have updated it via Pause/Resume
  // while the modal was closed). Idempotent on re-renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed when `open` flips OR when `schedule.id` changes; not on every schedule mutation (the user is mid-edit)
  useEffect(() => {
    if (!open) return;
    setName(schedule.name);
    setAgent(schedule.target.agent);
    setRuntime(schedule.target.runtime ?? "");
    setBrief(schedule.target.brief);
    setDetails(schedule.target.details ?? "");
    setPreset({ kind: "advanced", expr: schedule.trigger.expr });
    setTz(schedule.trigger.tz);
    setSubmitError(null);
    setSubmitting(false);
  }, [open, schedule.id]);

  const tzOptions = useMemo(
    () => buildTimezoneOptions([schedule.trigger.tz, ...existingTimezones]),
    [schedule.trigger.tz, existingTimezones],
  );

  const expr = useMemo(() => presetToCron(preset), [preset]);
  const presetError = useMemo(() => validatePreset(preset), [preset]);

  // Live preview, same debounce + AbortController shape as
  // CreateScheduleModal so the user gets immediate feedback after
  // typing a new cron expression. Short-circuits on local validation
  // failures and on tz === "".
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
          if (isAbortError(e)) return;
          if (ctrl.signal.aborted) return;
          setPreview(null);
          setPreviewError(errorMessage(e));
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

  // Build the sparse PATCH body. Trim-before-compare matches the
  // "no diff disables submit" gate to the actual wire payload.
  const patchBody = useMemo<PatchScheduleBody>(() => {
    const body: PatchScheduleBody = {};
    const trimmedName = name.trim();
    if (trimmedName !== schedule.name) body.name = trimmedName;

    const trimmedBrief = brief.trim();
    const trimmedDetails = details.trim();

    const target: NonNullable<PatchScheduleBody["target"]> = {};
    if (agent !== schedule.target.agent) target.agent = agent;
    if (trimmedBrief !== schedule.target.brief) target.brief = trimmedBrief;
    if (trimmedDetails !== (schedule.target.details ?? "")) {
      target.details = trimmedDetails === "" ? null : trimmedDetails;
    }
    if (runtime !== (schedule.target.runtime ?? "")) {
      target.runtime = runtime === "" ? null : runtime;
    }
    if (Object.keys(target).length > 0) body.target = target;

    if (expr !== schedule.trigger.expr || tz !== schedule.trigger.tz) {
      body.trigger = { kind: "cron", expr, tz };
    }
    return body;
  }, [name, agent, brief, details, runtime, expr, tz, schedule]);

  const hasDiff = Object.keys(patchBody).length > 0;

  const canSubmit =
    !submitting &&
    hasDiff &&
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
      await patchSchedule(schedule.id, patchBody);
      // PATCH returns `ScheduleView` (no `describe`). Re-fetch via
      // `getSchedule` so the merged `ScheduleDetail` carries the
      // server's fresh `describe` whether or not the trigger changed
      // — one round-trip, no branching.
      const merged = await getSchedule(schedule.id);
      onPatched(merged);
      onClose();
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Edit schedule — ${schedule.name}`} size="large">
      <form onSubmit={onSubmit} data-testid="edit-schedule-form">
        <div className="modal__body">
          <label htmlFor="edit-schedule-name">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Name
            </div>
            <input
              id="edit-schedule-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              className="input"
              style={{ width: "100%" }}
              required
              data-testid="edit-schedule-name"
            />
          </label>

          <label htmlFor="edit-schedule-agent">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Agent
            </div>
            <select
              id="edit-schedule-agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              disabled={submitting || agents.length === 0}
              required
              className="select select--full"
              data-testid="edit-schedule-agent"
            >
              {/* If the schedule's current agent isn't in the installed list, surface
                  it anyway as a disabled-ish option so submit doesn't silently
                  rewrite to the top of the list. */}
              {!agents.some((a) => a.agent.fqn === agent) && agent !== "" ? (
                <option value={agent}>{agent} (not installed)</option>
              ) : null}
              {agents.map((a) => (
                <option key={a.agent.fqn} value={a.agent.fqn}>
                  {a.agent.fqn}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor="edit-schedule-runtime">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Runtime
            </div>
            <select
              id="edit-schedule-runtime"
              value={runtime}
              onChange={(e) => setRuntime(e.target.value)}
              disabled={submitting}
              className="select select--full"
              data-testid="edit-schedule-runtime"
            >
              <option value="">(server default)</option>
              {runtime !== "" && !runtimes.includes(runtime) ? (
                <option value={runtime}>{runtime} (not registered)</option>
              ) : null}
              {runtimes.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor="edit-schedule-brief">
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
                data-testid="edit-schedule-brief-counter"
              >
                {brief.length}/200
              </span>
            </div>
            <input
              id="edit-schedule-brief"
              type="text"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              disabled={submitting}
              maxLength={200}
              className="input"
              style={{ width: "100%" }}
              required
              data-testid="edit-schedule-brief"
            />
          </label>

          <label htmlFor="edit-schedule-details">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Details (optional — clear to remove)
            </div>
            <textarea
              id="edit-schedule-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              disabled={submitting}
              rows={4}
              className="input"
              style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
              data-testid="edit-schedule-details"
            />
          </label>

          <PresetEditor
            preset={preset}
            onChange={setPreset}
            disabled={submitting}
            idPrefix="edit-schedule"
          />

          <label htmlFor="edit-schedule-tz">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Timezone
            </div>
            <select
              id="edit-schedule-tz"
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              disabled={submitting}
              className="select select--full"
              data-testid="edit-schedule-tz"
            >
              {tzOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <section
            aria-label="Preview"
            data-testid="edit-schedule-preview"
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
                data-testid="edit-schedule-cron-chip"
              >
                {expr}
              </code>
            </div>
            {presetError !== null ? (
              <p
                className="muted"
                style={{ fontSize: 12, margin: 0 }}
                data-testid="edit-schedule-preset-error"
              >
                {presetError}
              </p>
            ) : previewError !== null ? (
              <p
                className="alert alert--error"
                style={{ fontSize: 12, margin: 0 }}
                data-testid="edit-schedule-preview-error"
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
                  data-testid="edit-schedule-preview-describe"
                >
                  {preview.describe}
                </p>
                <ul
                  style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}
                  data-testid="edit-schedule-preview-next"
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
              data-testid="edit-schedule-submit-error"
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
            data-testid="edit-schedule-submit"
            title={!hasDiff ? "No changes to save" : undefined}
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
