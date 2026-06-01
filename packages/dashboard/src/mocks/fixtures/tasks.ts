import type { TaskRecord } from "../../api/index.js";

// Absolute paths are what the server stores in `success.artifacts`; the
// dashboard's ArtifactsTab extracts the basename (after `/` or `\`) as the
// segment passed to `/tasks/:tid/artifact/:name`, so the basenames here must
// match the keys in `artifactBodies` (see fixtures/index.ts).
const ART_DIR = "/mock/workspaces/designer/tasks";

/**
 * Hand-authored task fixtures covering issue #212's coverage matrix:
 *
 *   - status: running / succeeded / failed / cancelled
 *   - artifact count: 0 / 1 / N
 *   - artifact type: html / image / code (markdown/txt) / text / json
 *   - metadata.runtime: copilot + at least one alternative
 *   - origin: standalone + schedule (with metadata.scheduleId)
 *
 * Keep this list <= 10 entries — one task can cover several axes at once.
 */
export const fixtureTasks: TaskRecord[] = [
  {
    id: "running-with-activity",
    agent: "emploke/dev",
    brief: "Run a long multi-artifact task with live activity stream.",
    details:
      "This fixture exercises the running-state polish (status pill, activity stream replay, multi-artifact dropdown).",
    origin: "standalone",
    status: "running",
    metadata: {
      workdir: `${ART_DIR}/running-with-activity`,
      runtime: "copilot",
      runtimeSessionId: "copilot-rt-running-1",
    },
    createdAt: "2026-05-27T22:00:00.000Z",
    startedAt: "2026-05-27T22:00:01.000Z",
  },
  {
    id: "single-html",
    agent: "emploke/review",
    brief: "Review PR #999 — designer mode rollout",
    origin: "standalone",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/single-html`,
      runtime: "copilot",
      runtimeSessionId: "copilot-rt-single-1",
    },
    createdAt: "2026-05-26T14:30:00.000Z",
    startedAt: "2026-05-26T14:30:02.000Z",
    endedAt: "2026-05-26T14:34:11.000Z",
    success: {
      output: "Review posted: 4 nits + 1 blocker.",
      artifacts: [`${ART_DIR}/single-html/sample.html`],
    },
  },
  {
    id: "code-markdown",
    agent: "emploke/dev",
    brief: "Generate release notes draft",
    origin: "standalone",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/code-markdown`,
      runtime: "claude",
      runtimeSessionId: "claude-rt-code-1",
    },
    createdAt: "2026-05-25T09:15:00.000Z",
    startedAt: "2026-05-25T09:15:00.500Z",
    endedAt: "2026-05-25T09:16:42.000Z",
    success: {
      output: "Drafted CHANGELOG entry under v0.5.7.",
      artifacts: [`${ART_DIR}/code-markdown/sample.md`, `${ART_DIR}/code-markdown/sample.txt`],
    },
  },
  {
    id: "no-artifacts",
    agent: "emploke/dev",
    brief: "Reproduce flake in TasksFilters.test.tsx",
    origin: "standalone",
    status: "failed",
    metadata: {
      workdir: `${ART_DIR}/no-artifacts`,
      runtime: "copilot",
      runtimeSessionId: "copilot-rt-no-arts-1",
    },
    createdAt: "2026-05-24T18:00:00.000Z",
    startedAt: "2026-05-24T18:00:00.250Z",
    endedAt: "2026-05-24T18:02:30.000Z",
    failure: {
      kind: "exited",
      exit_code: 1,
      message: "Vitest exited with code 1 (3 tests failing).",
    },
  },
  {
    id: "cancelled-no-arts",
    agent: "emploke/dev",
    brief: "Refactor TaskDetail layout (cancelled mid-run)",
    origin: "standalone",
    status: "cancelled",
    metadata: {
      workdir: `${ART_DIR}/cancelled-no-arts`,
      runtime: "claude",
      runtimeSessionId: "claude-rt-cancelled-1",
    },
    createdAt: "2026-05-23T10:00:00.000Z",
    startedAt: "2026-05-23T10:00:01.000Z",
    endedAt: "2026-05-23T10:05:00.000Z",
    cancellation: {
      kind: "user",
      message: "User clicked Cancel from the dashboard.",
    },
  },
  {
    id: "schedule-launched",
    agent: "emploke/review",
    brief: "Nightly diff review (scheduled)",
    origin: "schedule",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/schedule-launched`,
      runtime: "copilot",
      runtimeSessionId: "copilot-rt-sched-1",
      scheduleId: "sched-nightly-review",
    },
    createdAt: "2026-05-27T02:00:00.000Z",
    startedAt: "2026-05-27T02:00:01.000Z",
    endedAt: "2026-05-27T02:03:14.000Z",
    success: {
      output: "Nightly diff review complete — 0 blockers.",
      artifacts: [`${ART_DIR}/schedule-launched/sample.json`],
    },
  },
  {
    id: "running-multi-bin",
    agent: "emploke/dev",
    brief: "Render image artifact + code review summary",
    origin: "standalone",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/running-multi-bin`,
      runtime: "copilot",
      runtimeSessionId: "copilot-rt-multi-bin-1",
    },
    createdAt: "2026-05-22T08:00:00.000Z",
    startedAt: "2026-05-22T08:00:00.250Z",
    endedAt: "2026-05-22T08:01:42.000Z",
    success: {
      output: "Rendered preview PNG and supporting notes.",
      artifacts: [
        `${ART_DIR}/running-multi-bin/sample.png`,
        `${ART_DIR}/running-multi-bin/sample.md`,
      ],
    },
  },
  // Schedule-launched fires for the #61 PR-4 schedules page. Each
  // `metadata.scheduleId` matches one of the entries in
  // `fixtureSchedules`, so the per-schedule "Recent fires" panel on
  // the schedule detail surface has rows to render. Status mix keeps
  // the StatusBadge variants (success / failure / running) all
  // exercised in screenshots.
  {
    id: "sched-cleanup-fire-1",
    agent: "emploke/dev",
    brief: "Nightly cleanup",
    origin: "schedule",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/sched-cleanup-fire-1`,
      runtime: "copilot",
      runtimeSessionId: "copilot-rt-cleanup-1",
      scheduleId: "sched-nightly-cleanup",
      firedAt: "2026-05-27T19:00:00.000Z",
    },
    createdAt: "2026-05-27T19:00:00.000Z",
    startedAt: "2026-05-27T19:00:01.000Z",
    endedAt: "2026-05-27T19:04:12.000Z",
    success: {
      output: "Reclaimed 412 MB of session caches; 0 errors.",
      artifacts: [],
    },
  },
  {
    id: "sched-cleanup-fire-2",
    agent: "emploke/dev",
    brief: "Nightly cleanup",
    origin: "schedule",
    status: "failed",
    metadata: {
      workdir: `${ART_DIR}/sched-cleanup-fire-2`,
      runtime: "copilot",
      runtimeSessionId: "copilot-rt-cleanup-2",
      scheduleId: "sched-nightly-cleanup",
      firedAt: "2026-05-26T19:00:00.000Z",
    },
    createdAt: "2026-05-26T19:00:00.000Z",
    startedAt: "2026-05-26T19:00:01.000Z",
    endedAt: "2026-05-26T19:00:42.000Z",
    failure: {
      kind: "exited",
      exit_code: 2,
      message: "Cache root /var/cache/emploke was read-only (permission denied).",
    },
  },
  {
    id: "sched-report-fire-running",
    agent: "emploke/review",
    brief: "Hourly health report",
    origin: "schedule",
    status: "running",
    metadata: {
      workdir: `${ART_DIR}/sched-report-fire-running`,
      runtime: "copilot",
      runtimeSessionId: "copilot-rt-report-1",
      scheduleId: "sched-hourly-report",
      firedAt: "2026-05-27T23:00:00.000Z",
    },
    createdAt: "2026-05-27T23:00:00.000Z",
    startedAt: "2026-05-27T23:00:01.000Z",
  },
  {
    id: "sched-report-fire-prev",
    agent: "emploke/review",
    brief: "Hourly health report",
    origin: "schedule",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/sched-report-fire-prev`,
      runtime: "copilot",
      runtimeSessionId: "copilot-rt-report-prev",
      scheduleId: "sched-hourly-report",
      firedAt: "2026-05-27T22:00:00.000Z",
    },
    createdAt: "2026-05-27T22:00:00.000Z",
    startedAt: "2026-05-27T22:00:01.000Z",
    endedAt: "2026-05-27T22:01:23.000Z",
    success: {
      output: "12 runtime events; 0 anomalies flagged.",
      artifacts: [],
    },
  },
  {
    id: "sched-digest-fire-pre-pause",
    agent: "emploke/dev",
    brief: "Weekly digest (last run before pause)",
    origin: "schedule",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/sched-digest-fire-pre-pause`,
      runtime: "claude",
      runtimeSessionId: "claude-rt-digest-1",
      scheduleId: "sched-weekly-digest",
      firedAt: "2026-05-19T01:00:00.000Z",
    },
    createdAt: "2026-05-19T01:00:00.000Z",
    startedAt: "2026-05-19T01:00:01.000Z",
    endedAt: "2026-05-19T01:06:30.000Z",
    success: {
      output: "Digest published; 38 PRs covered.",
      artifacts: [],
    },
  },
];
