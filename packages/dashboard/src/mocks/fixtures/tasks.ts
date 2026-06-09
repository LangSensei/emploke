import type { TaskRecord } from "../../api/index.js";
import { fixtureWorkflowMockIds as WF_IDS } from "./workflows.js";

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
  // Workflow-launched task fixtures (origin: "workflow") so the Mode B
  // drill-down from the Workflows page's Graph tab can resolve real
  // task records. Ids match the `taskId` / `id` values on
  // `WorkflowNodeWire` in `fixtureWorkflowDags` via the shared
  // `fixtureWorkflowMockIds` map. Briefs / agents mirror the
  // originating node so the right-pane TaskView shows continuity.
  {
    id: WF_IDS.tasks.migCoord0,
    agent: "emploke/dev",
    brief: "Coordinator: plan auth-module OAuth migration",
    origin: "workflow",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/${WF_IDS.tasks.migCoord0}`,
      runtime: "copilot",
      workflowId: "20260608-1f3a7b9c",
      workflowNodeId: WF_IDS.nodes.migCoord0,
    },
    createdAt: "2026-05-27T21:00:00.000Z",
    startedAt: "2026-05-27T21:00:01.000Z",
    endedAt: "2026-05-27T21:20:00.000Z",
    success: { output: "Plan emitted; queued phase-1 task node.", artifacts: [] },
  },
  {
    id: WF_IDS.tasks.migTask1a,
    agent: "emploke/dev",
    brief: "Replace session middleware with OAuth in packages/server",
    origin: "workflow",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/${WF_IDS.tasks.migTask1a}`,
      runtime: "copilot",
      workflowId: "20260608-1f3a7b9c",
      workflowNodeId: WF_IDS.nodes.migTask1a,
    },
    createdAt: "2026-05-27T21:21:00.000Z",
    startedAt: "2026-05-27T21:21:02.000Z",
    endedAt: "2026-05-27T22:30:00.000Z",
    success: { output: "Patch applied; tests green.", artifacts: [] },
  },
  {
    id: WF_IDS.tasks.migCoord2,
    agent: "emploke/dev",
    brief: "Coordinator: review patch + queue regression sweep",
    origin: "workflow",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/${WF_IDS.tasks.migCoord2}`,
      runtime: "copilot",
      workflowId: "20260608-1f3a7b9c",
      workflowNodeId: WF_IDS.nodes.migCoord2,
    },
    createdAt: "2026-05-27T22:31:00.000Z",
    startedAt: "2026-05-27T22:31:01.000Z",
    endedAt: "2026-05-27T22:50:00.000Z",
    success: { output: "Queued phase-3 worker.", artifacts: [] },
  },
  {
    id: WF_IDS.tasks.migTask3a,
    agent: "emploke/review",
    brief: "Run the auth integration suite + summarise failures",
    origin: "workflow",
    status: "running",
    metadata: {
      workdir: `${ART_DIR}/${WF_IDS.tasks.migTask3a}`,
      runtime: "claude",
      workflowId: "20260608-1f3a7b9c",
      workflowNodeId: WF_IDS.nodes.migTask3a,
    },
    createdAt: "2026-05-27T22:51:00.000Z",
    startedAt: "2026-05-27T22:51:02.000Z",
  },
  {
    id: WF_IDS.tasks.logCoord0,
    agent: "emploke/review",
    brief: "Coordinator: stage logger refactor across packages/catalog",
    origin: "workflow",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/${WF_IDS.tasks.logCoord0}`,
      runtime: "copilot",
      workflowId: "20260607-2e4b8cad",
      workflowNodeId: WF_IDS.nodes.logCoord0,
    },
    createdAt: "2026-05-27T00:00:00.000Z",
    startedAt: "2026-05-27T00:00:01.000Z",
    endedAt: "2026-05-27T00:10:00.000Z",
    success: { output: "Queued two phase-1 workers.", artifacts: [] },
  },
  {
    id: WF_IDS.tasks.logTask1a,
    agent: "emploke/dev",
    brief: "Replace console.log calls in packages/catalog",
    origin: "workflow",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/${WF_IDS.tasks.logTask1a}`,
      runtime: "copilot",
      workflowId: "20260607-2e4b8cad",
      workflowNodeId: WF_IDS.nodes.logTask1a,
    },
    createdAt: "2026-05-27T00:11:00.000Z",
    startedAt: "2026-05-27T00:11:02.000Z",
    endedAt: "2026-05-27T01:50:00.000Z",
    success: { output: "Migrated 23 call sites.", artifacts: [] },
  },
  {
    id: WF_IDS.tasks.logTask1b,
    agent: "emploke/dev",
    brief: "Add structured-logger happy-path tests",
    origin: "workflow",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/${WF_IDS.tasks.logTask1b}`,
      runtime: "copilot",
      workflowId: "20260607-2e4b8cad",
      workflowNodeId: WF_IDS.nodes.logTask1b,
    },
    createdAt: "2026-05-27T00:12:00.000Z",
    startedAt: "2026-05-27T00:12:01.000Z",
    endedAt: "2026-05-27T01:55:00.000Z",
    success: { output: "Six tests added.", artifacts: [] },
  },
  {
    id: WF_IDS.tasks.bumpCoord0,
    agent: "emploke/dev",
    brief: "Coordinator: bump contracts version (failed)",
    origin: "workflow",
    status: "failed",
    metadata: {
      workdir: `${ART_DIR}/${WF_IDS.tasks.bumpCoord0}`,
      runtime: "copilot",
      workflowId: "20260606-3d5c9dbe",
      workflowNodeId: WF_IDS.nodes.bumpCoord0,
    },
    createdAt: "2026-05-26T00:00:00.000Z",
    startedAt: "2026-05-26T00:00:01.000Z",
    endedAt: "2026-05-26T01:00:00.000Z",
    failure: { kind: "exited", exit_code: 1, message: "Coordinator hit an unrecoverable error." },
  },
  {
    id: WF_IDS.tasks.brandCoord0,
    agent: "emploke/designer",
    brief: "Coordinator: brand kit landing-page plan",
    origin: "workflow",
    status: "succeeded",
    metadata: {
      workdir: `${ART_DIR}/${WF_IDS.tasks.brandCoord0}`,
      runtime: "copilot",
      workflowId: "20260605-4e6dabcf",
      workflowNodeId: WF_IDS.nodes.brandCoord0,
    },
    createdAt: "2026-05-25T00:00:00.000Z",
    startedAt: "2026-05-25T00:00:01.000Z",
    endedAt: "2026-05-25T00:20:00.000Z",
    success: { output: "Plan emitted.", artifacts: [] },
  },
  {
    id: WF_IDS.tasks.brandTask1a,
    agent: "emploke/designer",
    brief: "Draft hero section copy + image layout",
    origin: "workflow",
    status: "cancelled",
    metadata: {
      workdir: `${ART_DIR}/${WF_IDS.tasks.brandTask1a}`,
      runtime: "copilot",
      workflowId: "20260605-4e6dabcf",
      workflowNodeId: WF_IDS.nodes.brandTask1a,
    },
    createdAt: "2026-05-25T00:21:00.000Z",
    startedAt: "2026-05-25T00:21:02.000Z",
    endedAt: "2026-05-25T02:00:00.000Z",
    cancellation: { kind: "user", message: "Cancelled by workflow operator." },
  },
];
