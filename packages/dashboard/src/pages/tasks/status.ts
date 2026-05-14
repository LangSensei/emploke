import type { TaskStatus } from "../../api";
import { serverNow } from "../../serverClock";

/**
 * Fallback poll cadence used while the server config is still loading or
 * if the server omits the field. Matches the server-side default in
 * `configRoutes` so behaviour is the same in either path.
 */
export const DEFAULT_POLL_INTERVAL_MS = 4000;

// `cancelled` is currently unreachable — the kernel exposes the status (see
// `TaskStatus` in @emploke/task) but no manager API emits a cancel event yet.
// The label/tone are wired up so a future user-cancel API drops in without
// UI work; until then users will only ever see the other four statuses.
export const STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: "Not started",
  running: "Running",
  success: "Success",
  failure: "Failure",
  cancelled: "Cancelled",
};

export const STATUS_TONE: Record<TaskStatus, string> = {
  not_started: "muted",
  running: "info",
  success: "ok",
  failure: "warn",
  cancelled: "muted",
};

// Sentinel values for the "All" option in the dropdowns. Plain strings keep
// the <select value> contract simple (vs `null`, which doesn't round-trip
// through DOM string serialization).
export const ALL_AGENTS = "__all__";
export const ALL_RUNTIMES = "__all__";

export type TimePreset = "today" | "7d" | "30d" | "all";

export const TIME_PRESETS: { value: TimePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

/**
 * Convert a preset to a millisecond cutoff. Anchored on the server's
 * approximate clock (`serverNow()` from `../../serverClock`) rather than
 * local `Date.now()`, so cutoffs match what the server actually sees
 * even if the user's laptop clock has drifted.
 */
export function presetToSinceMs(preset: TimePreset): number | null {
  const nowDate = serverNow();
  const nowMs = nowDate.getTime();
  switch (preset) {
    case "today": {
      const d = new Date(nowDate);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "7d":
      return nowMs - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return nowMs - 30 * 24 * 60 * 60 * 1000;
    case "all":
      return null;
  }
}
