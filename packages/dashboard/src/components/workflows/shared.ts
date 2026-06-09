/**
 * Shared constants + helpers for the Workflows page family
 * (`pages/Workflows.tsx`, `components/workflows/*.tsx`,
 * `pages/workflows/*.tsx`). Mirrors the layout of
 * `components/schedules/shared.ts` so each component file stays narrow.
 */

import type { WorkflowHeaderWire } from "../../api";

/**
 * Hard-coded poll cadence for workflow list + detail. The server-config
 * pipeline (`config.tasks.pollIntervalMs`) doesn't carry a workflow
 * slot yet; once it does, the page can read from there instead.
 */
export const WORKFLOW_POLL_INTERVAL_MS = 2000;

/**
 * Sort a list of workflows by `createdAt` descending so the most
 * recently dispatched run sits at the top — the same ordering the
 * Tasks page uses for its list. Stable for identical timestamps via
 * the secondary id comparator.
 */
export function sortByCreatedDesc(rows: readonly WorkflowHeaderWire[]): WorkflowHeaderWire[] {
  return rows.slice().sort((a, b) => {
    const cmp = b.createdAt.localeCompare(a.createdAt);
    if (cmp !== 0) return cmp;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Tone bucket for the four terminal+running workflow statuses. Used by
 * both `WorkflowStatusBadge` (label color) and `WorkflowListItem` (row
 * tint). Exhaustive switch with a `never` fall-through so any future
 * status addition becomes a compile error here instead of silently
 * rendering as the default tone.
 *
 * Mapping is locked to the Tasks page's `STATUS_TONE` (see
 * `components/tasks/shared.ts`) — same status, same colour. In
 * particular `cancelled` maps to `muted` (gray) so the workflow
 * CANCELLED badge does not visually collide with the Schedules
 * PAUSED badge (amber/warn).
 */
export type WorkflowStatusTone = "info" | "success" | "danger" | "muted";

export function workflowStatusTone(status: WorkflowHeaderWire["status"]): WorkflowStatusTone {
  switch (status) {
    case "running":
      return "info";
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "cancelled":
      return "muted";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export const WORKFLOW_STATUS_LABEL: Record<WorkflowHeaderWire["status"], string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Terminal statuses — used to gate the cancel CTA and stop polling. */
export function isTerminal(status: WorkflowHeaderWire["status"]): boolean {
  return status !== "running";
}

/**
 * Two-bucket grouping used by `WorkflowList` to slice the list into
 * Running / Completed sections. Mirrors the Tasks page grouping; the
 * three terminal statuses (`succeeded` / `failed` / `cancelled`)
 * collapse into `completed`.
 */
export type StatusGroup = "running" | "completed";

export function statusGroup(status: WorkflowHeaderWire["status"]): StatusGroup {
  return status === "running" ? "running" : "completed";
}
