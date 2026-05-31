import type { ScheduleDetail } from "../../api.js";

/**
 * Hand-authored schedule fixtures (PR 4/4 of #61). Stored in the
 * DETAIL shape (i.e. `Schedule & { describe }`) because the list
 * handler can synthesise the list view by stripping `describe`,
 * whereas the reverse would need a fake cronstrue call we don't
 * want at the mock layer.
 *
 * `nextFireAt` is hand-set relative to a fixed `2026-05-28T00:00:00Z`
 * epoch so the default list sort (ascending by `nextFireAt`) is
 * stable for screenshots.
 *
 * `target.agent` FQNs must exist in `fixtureAgents` so the agent
 * filter dropdown lists them and the cross-link from the Agents
 * page surfaces the right rows. The four agents used here —
 * `emploke/dev`, `emploke/review`, `emploke/designer` — are all
 * present in `fixtureAgents`.
 */
const EPOCH = Date.parse("2026-05-28T00:00:00.000Z");

function isoOffsetHours(h: number): string {
  return new Date(EPOCH + h * 3_600_000).toISOString();
}

export const fixtureSchedules: ScheduleDetail[] = [
  {
    id: "sched-nightly-cleanup",
    name: "Nightly cleanup",
    trigger: { kind: "cron", expr: "0 3 * * *", tz: "Asia/Shanghai" },
    target: {
      kind: "task",
      agent: "emploke/dev",
      runtime: "copilot",
      brief: "Nightly artifact + cache cleanup",
      details:
        "Sweep ephemeral artifacts, prune session caches older than 7 days, and report disk reclaim totals in the artifact JSON. Refer to docs/operations/cleanup-runbook.md for the full sweep order; keep the run idempotent so a missed night is recovered on the next fire without double-deletion.",
    },
    enabled: true,
    createdAt: "2026-05-01T08:00:00.000Z",
    updatedAt: "2026-05-20T08:00:00.000Z",
    lastFiredAt: "2026-05-27T19:00:00.000Z",
    nextFireAt: isoOffsetHours(3),
    describe: "每天 凌晨3:00",
  },
  {
    id: "sched-hourly-report",
    name: "Hourly health report",
    trigger: { kind: "cron", expr: "0 * * * *", tz: "Asia/Shanghai" },
    target: {
      kind: "task",
      agent: "emploke/review",
      runtime: "copilot",
      brief: "Hourly runtime-events digest to ops",
      details: "Summarise the last hour of runtime events and post the digest to ops.",
    },
    enabled: true,
    createdAt: "2026-05-10T12:00:00.000Z",
    updatedAt: "2026-05-22T09:00:00.000Z",
    lastFiredAt: "2026-05-27T23:00:00.000Z",
    nextFireAt: isoOffsetHours(1),
    describe: "每小时整点",
  },
  {
    id: "sched-weekly-digest",
    name: "Weekly digest (paused)",
    trigger: { kind: "cron", expr: "0 9 * * 1", tz: "Asia/Shanghai" },
    target: {
      kind: "task",
      agent: "emploke/dev",
      runtime: "claude",
      brief: "Weekly engineering digest publish",
      details: "Compose the weekly engineering digest and publish to the team feed.",
    },
    enabled: false,
    createdAt: "2026-04-15T08:00:00.000Z",
    updatedAt: "2026-05-24T08:00:00.000Z",
    nextFireAt: isoOffsetHours(33),
    describe: "每周一 上午9:00",
  },
  {
    id: "sched-paused-experiment",
    name: "Paused experiment",
    trigger: { kind: "cron", expr: "*/15 * * * *", tz: "UTC" },
    target: {
      kind: "task",
      agent: "emploke/designer",
      brief: "Dashboard visual-diff sweep",
      details:
        "Capture before/after screenshots of the dashboard and diff them; flag visual regressions.",
    },
    enabled: false,
    createdAt: "2026-05-18T08:00:00.000Z",
    updatedAt: "2026-05-26T08:00:00.000Z",
    nextFireAt: isoOffsetHours(0.25),
    describe: "每隔15分钟",
  },
];
