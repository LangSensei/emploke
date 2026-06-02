import type { AgentEntry } from "@emploke/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { getSchedule, type PatchScheduleBody, patchSchedule, type ScheduleDetail } from "../../api";
import { Modal } from "../Modal";
import { presetToCron, validatePreset } from "./cronPresets";
import { ScheduleFormFields } from "./ScheduleFormFields";
import {
  buildTimezoneOptions,
  isBriefValid,
  type ScheduleFormPatch,
  type ScheduleFormState,
} from "./scheduleFormShared";
import { useSchedulePreview } from "./useSchedulePreview";

export interface EditScheduleModalProps {
  open: boolean;
  schedule: ScheduleDetail;
  agents: AgentEntry[];
  runtimes: string[];
  /** Timezones already present on the workspace's existing schedules. */
  existingTimezones: string[];
  onClose: () => void;
  /**
   * Called after a successful PATCH with the freshly-built
   * {@link ScheduleDetail}. Re-uses `getSchedule` to refresh
   * `describe` whether or not the trigger changed — one round-trip,
   * no branching.
   */
  onPatched: (next: ScheduleDetail) => void;
}

/**
 * Edit-schedule modal — issue #233 follow-up.
 *
 * Mirrors `CreateScheduleModal`'s field layout (both render
 * {@link ScheduleFormFields}). Differences from Create:
 *   - Initial preset is `{ kind: "advanced", expr }` so the existing
 *     cron expression is shown verbatim (no reverse-parser to a
 *     preset kind — too brittle for the gain).
 *   - No `enabled` toggle (`ScheduleDetail`'s Pause/Resume owns
 *     enabled-state; two surfaces for one boolean is a source-of-
 *     truth conflict).
 *   - Submit builds a sparse {@link PatchScheduleBody} via field-by-
 *     field diff (trim-before-compare). `target.details` /
 *     `target.runtime` use RFC 7396 `null` when the user clears a
 *     previously-set value.
 *   - "No diff" disables submit so the button doesn't fire a
 *     meaningless PATCH.
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
  const [state, setState] = useState<ScheduleFormState>(() => ({
    name: schedule.name,
    agent: schedule.target.agent,
    runtime: schedule.target.runtime ?? "",
    brief: schedule.target.brief,
    details: schedule.target.details ?? "",
    preset: { kind: "advanced", expr: schedule.trigger.expr },
    tz: schedule.trigger.tz,
  }));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const dispatch = useCallback<(patch: ScheduleFormPatch) => void>(
    (patch) => setState((prev) => ({ ...prev, ...patch })),
    [],
  );

  // Reseed all fields whenever the modal opens or the underlying
  // schedule changes (parent may have updated it via Pause/Resume
  // while the modal was closed). Idempotent on re-renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed when `open` flips OR when `schedule.id` changes; not on every schedule mutation (the user is mid-edit)
  useEffect(() => {
    if (!open) return;
    setState({
      name: schedule.name,
      agent: schedule.target.agent,
      runtime: schedule.target.runtime ?? "",
      brief: schedule.target.brief,
      details: schedule.target.details ?? "",
      preset: { kind: "advanced", expr: schedule.trigger.expr },
      tz: schedule.trigger.tz,
    });
    setSubmitError(null);
    setSubmitting(false);
  }, [open, schedule.id]);

  const tzOptions = useMemo(
    () => buildTimezoneOptions([schedule.trigger.tz, ...existingTimezones]),
    [schedule.trigger.tz, existingTimezones],
  );

  const expr = useMemo(() => presetToCron(state.preset), [state.preset]);
  const presetError = useMemo(() => validatePreset(state.preset), [state.preset]);

  const { preview, previewLoading, previewError } = useSchedulePreview({
    enabled: open,
    expr,
    tz: state.tz,
    presetError,
  });

  // Build the sparse PATCH body. Trim-before-compare matches the
  // "no diff disables submit" gate to the actual wire payload.
  const patchBody = useMemo<PatchScheduleBody>(() => {
    const body: PatchScheduleBody = {};
    const trimmedName = state.name.trim();
    if (trimmedName !== schedule.name) body.name = trimmedName;

    const trimmedBrief = state.brief.trim();
    const trimmedDetails = state.details.trim();

    const target: NonNullable<PatchScheduleBody["target"]> = {};
    if (state.agent !== schedule.target.agent) target.agent = state.agent;
    if (trimmedBrief !== schedule.target.brief) target.brief = trimmedBrief;
    if (trimmedDetails !== (schedule.target.details ?? "")) {
      target.details = trimmedDetails === "" ? null : trimmedDetails;
    }
    if (state.runtime !== (schedule.target.runtime ?? "")) {
      target.runtime = state.runtime === "" ? null : state.runtime;
    }
    if (Object.keys(target).length > 0) body.target = target;

    if (expr !== schedule.trigger.expr || state.tz !== schedule.trigger.tz) {
      body.trigger = { kind: "cron", expr, tz: state.tz };
    }
    return body;
  }, [state, expr, schedule]);

  const hasDiff = Object.keys(patchBody).length > 0;

  const canSubmit =
    !submitting &&
    hasDiff &&
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
      await patchSchedule(schedule.id, patchBody);
      // PATCH returns `ScheduleView` (no `describe`). Re-fetch via
      // `getSchedule` so the merged `ScheduleDetail` carries the
      // server's fresh `describe` whether or not the trigger changed
      // — one round-trip, no branching.
      const merged = await getSchedule(schedule.id);
      onPatched(merged);
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Edit schedule — ${schedule.name}`} size="large">
      <form onSubmit={onSubmit} data-testid="edit-schedule-form">
        <div className="modal__body">
          <ScheduleFormFields
            idPrefix="edit-schedule"
            testIdPrefix="edit-schedule"
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
            defaultOptionMode="always"
            detailsLabelSuffix=" — clear to remove"
          />

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
