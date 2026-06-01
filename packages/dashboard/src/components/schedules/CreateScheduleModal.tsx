import type { AgentEntry } from "@emploke/catalog";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { type CreateScheduleBody, createSchedule, type ScheduleView } from "../../api";
import { Modal } from "../Modal";
import { presetToCron, validatePreset } from "./cronPresets";
import { ScheduleFormFields } from "./ScheduleFormFields";
import {
  browserTimezone,
  buildTimezoneOptions,
  isBriefValid,
  type ScheduleFormPatch,
  type ScheduleFormState,
} from "./scheduleFormShared";
import { useSchedulePreview } from "./useSchedulePreview";

export interface CreateScheduleModalProps {
  open: boolean;
  agents: AgentEntry[];
  runtimes: string[];
  /** Timezones already present on the workspace's existing schedules. Modal dedupes against UTC + browser local. */
  existingTimezones: string[];
  onClose: () => void;
  onCreated: (s: ScheduleView) => void;
}

/**
 * "New schedule" modal — issue #222.
 *
 * Preset-driven cron builder with a server-rendered live preview
 * (debounced 300ms via {@link useSchedulePreview}). Form-field
 * rendering is delegated to {@link ScheduleFormFields}, which is
 * shared with `EditScheduleModal`. Create-local concerns kept here:
 * agent/runtime/tz mount-effect reseeding, the "Start enabled"
 * checkbox (Edit owns enabled via Pause/Resume), and the disabled
 * "Target type" placeholder (forward-compat for `workflow`).
 *
 * Error-body preservation: `previewCron` and `createSchedule` both
 * surface the server's `error` string verbatim (via the shared
 * `extractError` helper in `api.ts`), so users see "Invalid cron
 * expression: …" rather than "schedule preview: 400".
 */
export function CreateScheduleModal({
  open,
  agents,
  runtimes,
  existingTimezones,
  onClose,
  onCreated,
}: CreateScheduleModalProps) {
  const [state, setState] = useState<ScheduleFormState>(() => ({
    name: "",
    agent: "",
    runtime: "",
    brief: "",
    details: "",
    preset: { kind: "daily", hour: 9, minute: 0 },
    tz: browserTimezone(),
  }));
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const dispatch = useCallback<(patch: ScheduleFormPatch) => void>(
    (patch) => setState((prev) => ({ ...prev, ...patch })),
    [],
  );

  // Mount-effect agent preselection. Re-runs each time the modal
  // opens or the agents list changes so re-opening with a fresh
  // agent list reseeds the dropdown.
  useEffect(() => {
    if (!open) return;
    setState((prev) => ({ ...prev, agent: agents[0]?.agent.fqn ?? "" }));
  }, [open, agents]);

  // Default runtime to the first registered kind. Empty runtime is a
  // valid submit — the server picks its default.
  useEffect(() => {
    if (!open) return;
    if (runtimes.length === 0) return;
    setState((prev) =>
      prev.runtime !== "" && runtimes.includes(prev.runtime)
        ? prev
        : { ...prev, runtime: runtimes[0] ?? "" },
    );
  }, [open, runtimes]);

  // Reseed the timezone on open in case the browser tz changed since
  // the last open (e.g. the user changed laptop tz between modal
  // opens). Cheap idempotent — no-op when the value is already right.
  useEffect(() => {
    if (!open) return;
    setState((prev) => (prev.tz !== "" ? prev : { ...prev, tz: browserTimezone() }));
  }, [open]);

  // Reset transient state on close so a re-open starts clean. Persist
  // the form fields themselves — re-opening immediately after closing
  // shouldn't drop the user's half-typed brief/details.
  useEffect(() => {
    if (!open) {
      setSubmitError(null);
      setSubmitting(false);
    }
  }, [open]);

  const tzOptions = useMemo(() => buildTimezoneOptions(existingTimezones), [existingTimezones]);
  const expr = useMemo(() => presetToCron(state.preset), [state.preset]);
  const presetError = useMemo(() => validatePreset(state.preset), [state.preset]);

  const { preview, previewLoading, previewError } = useSchedulePreview({
    enabled: open,
    expr,
    tz: state.tz,
    presetError,
  });

  const canSubmit =
    !submitting &&
    state.name.trim() !== "" &&
    state.agent !== "" &&
    isBriefValid(state.brief) &&
    presetError === null &&
    previewError === null;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body: CreateScheduleBody = {
        name: state.name.trim(),
        target: {
          agent: state.agent,
          brief: state.brief.trim(),
          ...(state.details.trim() ? { details: state.details.trim() } : {}),
          ...(state.runtime ? { runtime: state.runtime } : {}),
        },
        trigger: { kind: "cron", expr, tz: state.tz },
        enabled,
      };
      const created = await createSchedule(body);
      onCreated(created);
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New schedule" size="large">
      <form onSubmit={onSubmit} data-testid="create-schedule-form">
        <div className="modal__body">
          <ScheduleFormFields
            idPrefix="new-schedule"
            testIdPrefix="create-schedule"
            agents={agents}
            runtimes={runtimes}
            tzOptions={tzOptions}
            disabled={submitting}
            state={state}
            onChange={dispatch}
            expr={expr}
            presetError={presetError}
            preview={preview}
            previewLoading={previewLoading}
            previewError={previewError}
            defaultOptionMode="conditional"
            showNotRegisteredFallback={false}
            placeholders={{
              name: "Weekday morning summary",
              brief: "One-line summary the task list will show (e.g. Refresh weekday digest)",
              details: "Full instructions the agent will receive on each fire. Markdown OK.",
            }}
            beforeBrief={
              <label htmlFor="new-schedule-target-kind">
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                  Target type
                </div>
                <select
                  id="new-schedule-target-kind"
                  value="task"
                  disabled
                  className="select select--full"
                  data-testid="create-schedule-target-kind"
                >
                  <option value="task">Task</option>
                </select>
              </label>
            }
            beforePreview={
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
            }
          />

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
