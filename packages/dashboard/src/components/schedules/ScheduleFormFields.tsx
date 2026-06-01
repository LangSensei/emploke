import type { AgentEntry } from "@emploke/catalog";
import type { ReactNode } from "react";
import type { SchedulePreview } from "../../api";
import { PresetEditor } from "./PresetEditor";
import type { ScheduleFormPatch, ScheduleFormState } from "./scheduleFormShared";

export interface ScheduleFormFieldsProps {
  /**
   * Prefix for input `id` and `htmlFor` attributes (HTML-side only).
   * Create modal passes `"new-schedule"` to preserve the historical
   * id naming used on `main` before the W3g extraction; Edit passes
   * `"edit-schedule"`. Decoupled from `testIdPrefix` so the
   * data-testid namespace stays stable across the rename.
   */
  idPrefix: "new-schedule" | "edit-schedule";
  /**
   * Prefix for `data-testid` attributes. Create modal passes
   * `"create-schedule"` (matches the pre-extraction selectors that
   * dashboard tests rely on); Edit passes `"edit-schedule"`. Also
   * forwarded to {@link PresetEditor} since that component uses a
   * single prefix for both ids and testids.
   */
  testIdPrefix: "create-schedule" | "edit-schedule";
  agents: AgentEntry[];
  runtimes: string[];
  tzOptions: string[];
  /** Disable all inputs — typically `submitting === true`. */
  disabled: boolean;
  /** Controlled form state (modal owns the `useState`). */
  state: ScheduleFormState;
  /** Partial-state dispatcher: `{ name: "x" }` updates just that field. */
  onChange: (patch: ScheduleFormPatch) => void;
  /** Cron derived from `state.preset` (parent computes via `useMemo`). */
  expr: string;
  /** Local validation against the current preset; `null` when valid. */
  presetError: string | null;
  /** Live preview state from `useSchedulePreview`. */
  preview: SchedulePreview | null;
  previewLoading: boolean;
  previewError: string | null;
  /**
   * Optional row rendered between the Runtime select and the Brief
   * input. `CreateScheduleModal` injects the disabled target-type
   * (`Task`) placeholder here — forward-compat for `workflow`. Edit
   * doesn't render anything since the schedule's existing target
   * shape is fixed for the life of the schedule.
   */
  beforeBrief?: ReactNode;
  /**
   * Optional row rendered between the Timezone select and the
   * Preview section. `CreateScheduleModal` injects its "Start
   * enabled" checkbox here so it stays above the preview (matches
   * pre-extraction layout on `main`). Edit owns enabled-state via
   * Pause/Resume and renders nothing here.
   */
  beforePreview?: ReactNode;
  /**
   * Optional suffix appended to the Details label after `"Details
   * (optional"`. `EditScheduleModal` passes `" — clear to remove"`
   * to surface the "clearing the textarea removes the existing
   * value via RFC 7396 null" behaviour to the user; Create has no
   * existing value to clear so the suffix is omitted.
   */
  detailsLabelSuffix?: string;
  /**
   * Per-field placeholder text for the free-form inputs. Create
   * supplies all three (Create modal's pre-extraction text on
   * `main`); Edit omits them so the inputs render without
   * placeholders — matches Edit's pre-extraction behaviour where the
   * fields are always pre-filled from the schedule being edited.
   */
  placeholders?: {
    name?: string;
    brief?: string;
    details?: string;
  };
  /**
   * Runtime select default-option behaviour:
   *   - `"always"`: render `(server default)` unconditionally
   *     (matches Edit on `main` — the schedule may legitimately have
   *     "let server pick" as its setting).
   *   - `"conditional"`: render `(server default)` only when no
   *     runtimes are registered AND disable the select in that case
   *     (matches Create on `main` — Create seeds the runtime to
   *     `runtimes[0]`, so the `(server default)` sentinel is only
   *     meaningful when the runtime list itself is empty).
   */
  defaultOptionMode: "always" | "conditional";
  /**
   * When `true` (Edit), render a `(not registered)` fallback option
   * if `state.runtime` is set to a value not in `runtimes` — surfaces
   * the existing schedule's runtime even after the registry changes.
   * When `false` (Create), the fallback is omitted since Create
   * always seeds the runtime from `runtimes[0]` and therefore can
   * never end up with an unregistered value.
   */
  showNotRegisteredFallback?: boolean;
}

/**
 * Shared body of `CreateScheduleModal` and `EditScheduleModal`:
 * name + agent + runtime + brief + details + PresetEditor + TZ
 * dropdown + preview region. Controlled — the parent modal owns the
 * {@link ScheduleFormState} and feeds patches back via `onChange`.
 *
 * Extracted in the W3g polish PR (TN-B F1-3 audit). Two Create-only
 * divergences live outside this component: the disabled target-type
 * placeholder ships in via the `beforeBrief` slot; the `enabled`
 * checkbox is rendered inline in `CreateScheduleModal` itself.
 *
 * Agent + runtime selects are unified to handle both modes
 * declaratively — they show the "not installed" / "(server default)"
 * / "(not registered)" fallback options based on whether the
 * currently-selected value sits in the registered lists.
 */
export function ScheduleFormFields({
  idPrefix,
  testIdPrefix,
  agents,
  runtimes,
  tzOptions,
  disabled,
  state,
  onChange,
  expr,
  presetError,
  preview,
  previewLoading,
  previewError,
  beforeBrief,
  beforePreview,
  detailsLabelSuffix,
  placeholders,
  defaultOptionMode,
  showNotRegisteredFallback = true,
}: ScheduleFormFieldsProps) {
  const agentMissing = state.agent !== "" && !agents.some((a) => a.agent.fqn === state.agent);
  const runtimeMissing = state.runtime !== "" && !runtimes.includes(state.runtime);
  const runtimeDisabled =
    disabled || (defaultOptionMode === "conditional" && runtimes.length === 0);

  return (
    <>
      <label htmlFor={`${idPrefix}-name`}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Name
        </div>
        <input
          id={`${idPrefix}-name`}
          type="text"
          value={state.name}
          onChange={(e) => onChange({ name: e.target.value })}
          disabled={disabled}
          placeholder={placeholders?.name}
          className="input"
          style={{ width: "100%" }}
          required
          data-testid={`${testIdPrefix}-name`}
        />
      </label>

      <label htmlFor={`${idPrefix}-agent`}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Agent
        </div>
        <select
          id={`${idPrefix}-agent`}
          value={state.agent}
          onChange={(e) => onChange({ agent: e.target.value })}
          disabled={disabled || agents.length === 0}
          required
          className="select select--full"
          data-testid={`${testIdPrefix}-agent`}
        >
          {agents.length === 0 ? <option value="">(no installed agents)</option> : null}
          {/* If the schedule's current agent isn't in the installed list, surface
              it anyway as a fallback option so submit doesn't silently rewrite
              to the top of the list. Only fires for Edit (Create seeds from the
              top of the list, so its selected agent is always registered). */}
          {agentMissing ? <option value={state.agent}>{state.agent} (not installed)</option> : null}
          {agents.map((a) => (
            <option key={a.agent.fqn} value={a.agent.fqn}>
              {a.agent.fqn}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor={`${idPrefix}-runtime`}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Runtime
        </div>
        <select
          id={`${idPrefix}-runtime`}
          value={state.runtime}
          onChange={(e) => onChange({ runtime: e.target.value })}
          disabled={runtimeDisabled}
          className="select select--full"
          data-testid={`${testIdPrefix}-runtime`}
        >
          {/* `(server default)` mirrors pre-extraction `main` behaviour:
              Edit always renders it (a schedule may legitimately have
              "let server pick"); Create only renders it when there are
              zero installed runtimes (Create otherwise auto-seeds
              `runtimes[0]`, so the sentinel would just clutter the
              dropdown). */}
          {defaultOptionMode === "always" || runtimes.length === 0 ? (
            <option value="">(server default)</option>
          ) : null}
          {showNotRegisteredFallback && runtimeMissing ? (
            <option value={state.runtime}>{state.runtime} (not registered)</option>
          ) : null}
          {runtimes.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>

      {beforeBrief}

      <label htmlFor={`${idPrefix}-brief`}>
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
            className={state.brief.length > 200 ? "error" : "muted"}
            style={{ fontSize: 11 }}
            data-testid={`${testIdPrefix}-brief-counter`}
          >
            {state.brief.length}/200
          </span>
        </div>
        <input
          id={`${idPrefix}-brief`}
          type="text"
          value={state.brief}
          onChange={(e) => onChange({ brief: e.target.value })}
          disabled={disabled}
          placeholder={placeholders?.brief}
          maxLength={200}
          className="input"
          style={{ width: "100%" }}
          required
          data-testid={`${testIdPrefix}-brief`}
        />
      </label>

      <label htmlFor={`${idPrefix}-details`}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Details (optional{detailsLabelSuffix ?? ""})
        </div>
        <textarea
          id={`${idPrefix}-details`}
          value={state.details}
          onChange={(e) => onChange({ details: e.target.value })}
          disabled={disabled}
          placeholder={placeholders?.details}
          rows={4}
          className="input"
          style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
          data-testid={`${testIdPrefix}-details`}
        />
      </label>

      <PresetEditor
        preset={state.preset}
        onChange={(p) => onChange({ preset: p })}
        disabled={disabled}
        idPrefix={testIdPrefix}
      />

      <label htmlFor={`${idPrefix}-tz`}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Timezone
        </div>
        <select
          id={`${idPrefix}-tz`}
          value={state.tz}
          onChange={(e) => onChange({ tz: e.target.value })}
          disabled={disabled}
          className="select select--full"
          data-testid={`${testIdPrefix}-tz`}
        >
          {tzOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      {beforePreview}

      <section
        aria-label="Preview"
        data-testid={`${testIdPrefix}-preview`}
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
            title={`Cron expression in ${state.tz}`}
            data-testid={`${testIdPrefix}-cron-chip`}
          >
            {expr}
          </code>
        </div>
        {presetError !== null ? (
          <p
            className="muted"
            style={{ fontSize: 12, margin: 0 }}
            data-testid={`${testIdPrefix}-preset-error`}
          >
            {presetError}
          </p>
        ) : previewError !== null ? (
          <p
            className="alert alert--error"
            style={{ fontSize: 12, margin: 0 }}
            data-testid={`${testIdPrefix}-preview-error`}
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
              data-testid={`${testIdPrefix}-preview-describe`}
            >
              {preview.describe}
            </p>
            <ul
              style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}
              data-testid={`${testIdPrefix}-preview-next`}
            >
              {preview.nextRuns.map((iso) => (
                <li key={iso}>{iso}</li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
