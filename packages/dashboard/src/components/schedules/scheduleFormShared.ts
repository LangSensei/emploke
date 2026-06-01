import type { Preset, PresetKind } from "./cronPresets";

/**
 * Shared static data + tz helpers used by both `CreateScheduleModal`
 * and `EditScheduleModal`. Pure: no React, no DOM mutation.
 */

/**
 * Snapshot of the schedule-form's editable fields, shared between the
 * Create and Edit modals. Each modal owns a single `useState` of this
 * shape and threads it through `<ScheduleFormFields>` together with a
 * patch dispatcher ({@link ScheduleFormPatch}).
 *
 * Initial values differ per modal (Create starts empty + browser tz;
 * Edit seeds from the existing {@link ScheduleDetail}) — the union of
 * mutable fields does not, which is what makes this state shareable.
 */
export interface ScheduleFormState {
  name: string;
  agent: string;
  runtime: string;
  brief: string;
  details: string;
  preset: Preset;
  tz: string;
}

/**
 * Partial-update payload accepted by `<ScheduleFormFields>`'s
 * `onChange`. Modal dispatchers merge it into the prior state with
 * the usual `{ ...prev, ...patch }` reducer.
 */
export type ScheduleFormPatch = Partial<ScheduleFormState>;

/**
 * Brief gate shared by both modals' `canSubmit`. Mirrors the server's
 * /schedules constraint: non-empty after trim, ≤200 chars after trim,
 * and no embedded newlines (the brief is rendered as a single line on
 * the task list — newlines would clip mid-render).
 */
export function isBriefValid(brief: string): boolean {
  const trimmed = brief.trim();
  return trimmed !== "" && trimmed.length <= 200 && !brief.includes("\n") && !brief.includes("\r");
}

export const PRESET_OPTIONS: readonly { value: PresetKind; label: string }[] = [
  { value: "daily", label: "Every day at…" },
  { value: "weekdays", label: "Every weekday (Mon–Fri) at…" },
  { value: "weekly", label: "Every week on…" },
  { value: "monthly", label: "Every month on day…" },
  { value: "every-n-hours", label: "Every N hours" },
  { value: "every-n-minutes", label: "Every N minutes" },
  { value: "advanced", label: "Advanced (raw cron)" },
];

export const WEEKDAY_LABELS: readonly { value: number; label: string }[] = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Build the tz dropdown option list — browser local first, UTC
 * second, then any timezones already present on the workspace's
 * schedules (de-duplicated, order-preserving).
 */
export function buildTimezoneOptions(existing: readonly string[]): string[] {
  const browser = browserTimezone();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tz of [browser, "UTC", ...existing]) {
    if (tz && !seen.has(tz)) {
      seen.add(tz);
      out.push(tz);
    }
  }
  return out;
}
