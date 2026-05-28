/**
 * Pure preset → cron mapping for the "New schedule" modal (issue
 * #222). No React, no DOM, no side effects — easy to table-test.
 *
 * The module accepts arbitrary positive `n` for the every-N-hours /
 * every-N-minutes presets without complaint. The UX-level constraint
 * "n must divide 24 / 60 evenly" is enforced by the form's `<select>`
 * options (see CreateScheduleModal); keeping the pure module
 * unconstrained means tests can pin the exact cron output for any
 * input without fighting a runtime guard.
 *
 * Non-divisor intervals (e.g. `every 7 hours`) produce surprising
 * gaps in the cron expression — `0 *\/7 * * *` fires at hours
 * 0,7,14,21,0, a 3-hour gap across midnight. The form steers users
 * to divisors of 24 (`{1,2,3,4,6,8,12}`) and divisors of 60
 * (`{1,2,3,4,5,6,10,12,15,20,30}`); users wanting genuine non-divisor
 * intervals can drop to the Advanced preset and write the expression
 * themselves.
 */

export type PresetKind =
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "every-n-hours"
  | "every-n-minutes"
  | "advanced";

export interface DailyPreset {
  kind: "daily";
  hour: number;
  minute: number;
}

export interface WeekdaysPreset {
  kind: "weekdays";
  hour: number;
  minute: number;
}

export interface WeeklyPreset {
  kind: "weekly";
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  hour: number;
  minute: number;
}

export interface MonthlyPreset {
  kind: "monthly";
  /** 1..31. Combinations like "31st of Feb" are not validated here — the cron engine simply skips months without that day. */
  dayOfMonth: number;
  hour: number;
  minute: number;
}

export interface EveryNHoursPreset {
  kind: "every-n-hours";
  n: number;
}

export interface EveryNMinutesPreset {
  kind: "every-n-minutes";
  n: number;
}

export interface AdvancedPreset {
  kind: "advanced";
  expr: string;
}

export type Preset =
  | DailyPreset
  | WeekdaysPreset
  | WeeklyPreset
  | MonthlyPreset
  | EveryNHoursPreset
  | EveryNMinutesPreset
  | AdvancedPreset;

/**
 * Convert a preset to its 5-field cron expression
 * (`minute hour dayOfMonth month dayOfWeek`).
 *
 * `weekly.days` is sorted ascending before being joined so the cron
 * string is stable regardless of click order (`[5,1,3] → "1,3,5"`).
 * `advanced.expr` is trimmed but otherwise passed through verbatim;
 * syntax validation is the server's job (the preview round-trip
 * surfaces invalid expressions as inline errors in the modal).
 */
export function presetToCron(p: Preset): string {
  switch (p.kind) {
    case "daily":
      return `${p.minute} ${p.hour} * * *`;
    case "weekdays":
      return `${p.minute} ${p.hour} * * 1-5`;
    case "weekly":
      return `${p.minute} ${p.hour} * * ${[...p.days].sort((a, b) => a - b).join(",")}`;
    case "monthly":
      return `${p.minute} ${p.hour} ${p.dayOfMonth} * *`;
    case "every-n-hours":
      return `0 */${p.n} * * *`;
    case "every-n-minutes":
      return `*/${p.n} * * * *`;
    case "advanced":
      return p.expr.trim();
  }
}

/**
 * Divisors of 24 — the only `n` values that produce evenly-spaced
 * fires across the day for the `every-n-hours` preset. `24` is
 * excluded because `0 *\/24 * * *` is equivalent to `daily at 00:00`
 * and the dedicated `daily` preset is a clearer expression of intent.
 */
export const HOUR_DIVISORS: readonly number[] = [1, 2, 3, 4, 6, 8, 12];

/**
 * Divisors of 60 — the only `n` values that produce evenly-spaced
 * fires across each hour for the `every-n-minutes` preset.
 */
export const MINUTE_DIVISORS: readonly number[] = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];

/**
 * Cheap structural validation for a draft preset, used by the form
 * to enable/disable the submit button. Returns `null` when the
 * preset is structurally valid (the server still has the final say
 * on the cron expression's parseability); returns a human-readable
 * reason otherwise.
 *
 * Kept here next to `presetToCron` so the cron-mapping rules and
 * their input constraints live in one file.
 */
export function validatePreset(p: Preset): string | null {
  switch (p.kind) {
    case "daily":
    case "weekdays":
    case "monthly":
      if (!isHour(p.hour)) return "Hour must be between 0 and 23.";
      if (!isMinute(p.minute)) return "Minute must be between 0 and 59.";
      if (
        p.kind === "monthly" &&
        (!Number.isInteger(p.dayOfMonth) || p.dayOfMonth < 1 || p.dayOfMonth > 31)
      ) {
        return "Day of month must be between 1 and 31.";
      }
      return null;
    case "weekly":
      if (!isHour(p.hour)) return "Hour must be between 0 and 23.";
      if (!isMinute(p.minute)) return "Minute must be between 0 and 59.";
      if (p.days.length === 0) return "Pick at least one day of the week.";
      if (p.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return "Days of the week must be 0 (Sunday) through 6 (Saturday).";
      }
      return null;
    case "every-n-hours":
      if (!Number.isInteger(p.n) || p.n < 1) return "Interval must be a positive integer.";
      return null;
    case "every-n-minutes":
      if (!Number.isInteger(p.n) || p.n < 1) return "Interval must be a positive integer.";
      return null;
    case "advanced":
      if (p.expr.trim() === "") return "Cron expression cannot be empty.";
      return null;
  }
}

function isHour(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 23;
}

function isMinute(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 59;
}
