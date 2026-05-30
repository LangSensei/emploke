import type { PresetKind } from "./cronPresets";

/**
 * Shared static data + tz helpers used by both `CreateScheduleModal`
 * and `EditScheduleModal`. Pure: no React, no DOM mutation.
 */

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
