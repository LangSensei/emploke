/**
 * Shared constants + small helpers for the Tasks page family of
 * components (`TaskList`, `TaskListItem`, `TaskDetail`, …). Extracted
 * from the monolithic `pages/Tasks.tsx` during the master-detail
 * redesign (mission A) so each component file can be read on its own.
 *
 * No behaviour changes — every value here is a literal lift from the
 * pre-split Tasks.tsx.
 */

import type { TaskRecord, TaskStatus } from "../../api";
import { serverNow } from "../../serverClock";

// ADR-001 made `cancelled` first-class: TaskService.cancel(id) +
// POST /tasks/:id/cancel + `emploke task cancel` all produce this
// status.
export const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Bug-bash iter-1: succeeded was previously mapped to the `ok` tone which
// re-used the accent-blue colour ramp (same as running). Switched to a
// dedicated `success` tone (green) so the four states are visually distinct:
// succeeded → green, running → blue, failed → red, cancelled/queued → grey.
export const STATUS_TONE: Record<TaskStatus, string> = {
  running: "info",
  succeeded: "success",
  failed: "danger",
  cancelled: "muted",
};

// Sentinel values for the "All" option in the dropdowns. Plain strings
// keep the <select value> contract simple (vs `null`, which doesn't
// round-trip through DOM string serialization).
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
 * approximate clock (`serverNow()`) rather than local `Date.now()`,
 * so cutoffs match what the server actually sees even if the user's
 * laptop clock has drifted.
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

/** Extract the `metadata.runtime` string, or `null` when absent / wrong type. */
export function readRuntime(task: TaskRecord): string | null {
  const r = task.metadata?.runtime;
  return typeof r === "string" ? r : null;
}

/**
 * Status group used by the master-detail list.
 *
 * The TaskStatus enum is `running | succeeded | failed | cancelled` —
 * no `queued`/`not_started`. Per the bug-bash iter-1 brief we still
 * render the `not_started` header (always count 0) so the data shape
 * is predictable across refreshes: users see Running → Not started →
 * Completed and never wonder "where did my task go?" while a row is
 * in flight. No real status ever maps to `not_started`; it exists
 * purely as a visual placeholder bucket.
 */
export type StatusGroup = "running" | "not_started" | "completed";

export function statusGroup(status: TaskStatus): StatusGroup {
  return status === "running" ? "running" : "completed";
}
