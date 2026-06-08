import type { WorkflowDagWire, WorkflowHeaderWire } from "../../api";

/**
 * Hand-authored workflow fixtures. Anchored to a fixed
 * `2026-05-28T00:00:00Z` epoch so the list-sort (desc by createdAt)
 * and the relative-time labels render stably for screenshots.
 *
 * Coordinator-agent FQNs MUST appear in `fixtureAgents` so the agent
 * dropdown in the Create modal renders them and any cross-page link
 * resolves. The three FQNs used here — `emploke/dev`,
 * `emploke/review`, `emploke/designer` — are all registered there.
 *
 * The four fixtures cover the four terminal/non-terminal status
 * shapes:
 *
 *   - workflow-running-multistage  — running, 3-phase DAG with a
 *     coordinator wake at phase 2 chasing the worker that completed
 *     in phase 1 (the canonical "engine just woke me" shape).
 *   - workflow-succeeded-simple    — succeeded, full 2-phase DAG.
 *   - workflow-failed-early        — failed, single-worker DAG; the
 *     detail pane renders the substrate-gap outcome placeholder
 *     (`#334`) on the failed status alone.
 *   - workflow-cancelled-late      — cancelled mid-run; same
 *     substrate-gap placeholder applies.
 */
const EPOCH = Date.parse("2026-05-28T00:00:00.000Z");

function iso(offsetMinutes: number): string {
  return new Date(EPOCH + offsetMinutes * 60_000).toISOString();
}

export const fixtureWorkflows: readonly WorkflowHeaderWire[] = [
  {
    id: "wf-running-multistage",
    brief: "Migrate auth module to OAuth + add regression tests",
    details:
      "Replace the legacy session middleware with OAuth, then run a sweep to confirm no caller relied on the old session cookie. Coordinator should choose between scoped tests and a full suite once the migration patch lands.",
    status: "running",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: iso(-180),
    startedAt: iso(-180),
    iterationCount: 3,
  },
  {
    id: "wf-succeeded-simple",
    brief: "Refactor packages/catalog logging to the structured-logger API",
    details:
      "Move all `console.log` calls in packages/catalog to the structured logger and add one happy-path test per repository module.",
    status: "succeeded",
    coordinatorAgent: "emploke/review",
    metadata: {},
    createdAt: iso(-1440),
    startedAt: iso(-1440),
    endedAt: iso(-1320),
    iterationCount: 2,
  },
  {
    id: "wf-failed-early",
    brief: "Bump @emploke/contracts to 0.42 and update downstream callers",
    details: "Bump the version, run typecheck, then surface any breaking imports.",
    status: "failed",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: iso(-2880),
    startedAt: iso(-2880),
    endedAt: iso(-2820),
    iterationCount: 1,
  },
  {
    id: "wf-cancelled-late",
    brief: "Generate a marketing landing page from the new brand kit",
    details:
      "Coordinator turned out to be on the wrong agent; cancelled before phase 2 was scheduled.",
    status: "cancelled",
    coordinatorAgent: "emploke/designer",
    metadata: {},
    createdAt: iso(-4320),
    startedAt: iso(-4320),
    endedAt: iso(-4200),
    iterationCount: 2,
  },
];

const dagRunningMultistage: WorkflowDagWire = {
  workflow: fixtureWorkflows[0]!,
  nodes: [
    {
      id: "wfn-mig-coord-0",
      workflowId: "wf-running-multistage",
      status: "succeeded",
      phase: 0,
      taskId: "wf-task-mig-coord-0",
      spec: { kind: "coordinator", agent: "emploke/dev" },
      createdAt: iso(-180),
      readyAt: iso(-180),
      runningAt: iso(-180),
      endedAt: iso(-160),
    },
    {
      id: "wfn-mig-task-1a",
      workflowId: "wf-running-multistage",
      status: "succeeded",
      phase: 1,
      taskId: "wf-task-mig-task-1a",
      spec: {
        kind: "task",
        agent: "emploke/dev",
        brief: "Replace session middleware with OAuth in packages/server",
        runtime: "copilot",
      },
      createdAt: iso(-159),
      readyAt: iso(-159),
      runningAt: iso(-158),
      endedAt: iso(-90),
    },
    {
      id: "wfn-mig-coord-2",
      workflowId: "wf-running-multistage",
      status: "succeeded",
      phase: 2,
      taskId: "wf-task-mig-coord-2",
      spec: { kind: "coordinator", agent: "emploke/dev" },
      createdAt: iso(-89),
      readyAt: iso(-89),
      runningAt: iso(-89),
      endedAt: iso(-70),
    },
    {
      id: "wfn-mig-task-3a",
      workflowId: "wf-running-multistage",
      status: "running",
      phase: 3,
      taskId: "wf-task-mig-task-3a",
      spec: {
        kind: "task",
        agent: "emploke/review",
        brief: "Run the auth integration suite + summarise failures",
        runtime: "claude",
      },
      createdAt: iso(-69),
      readyAt: iso(-69),
      runningAt: iso(-68),
    },
  ],
  edges: [
    { from: "wfn-mig-coord-0", to: "wfn-mig-task-1a" },
    { from: "wfn-mig-task-1a", to: "wfn-mig-coord-2" },
    { from: "wfn-mig-coord-2", to: "wfn-mig-task-3a" },
  ],
};

const dagSucceededSimple: WorkflowDagWire = {
  workflow: fixtureWorkflows[1]!,
  nodes: [
    {
      id: "wfn-log-coord-0",
      workflowId: "wf-succeeded-simple",
      status: "succeeded",
      phase: 0,
      taskId: "wf-task-log-coord-0",
      spec: { kind: "coordinator", agent: "emploke/review" },
      createdAt: iso(-1440),
      readyAt: iso(-1440),
      runningAt: iso(-1440),
      endedAt: iso(-1430),
    },
    {
      id: "wfn-log-task-1a",
      workflowId: "wf-succeeded-simple",
      status: "succeeded",
      phase: 1,
      taskId: "wf-task-log-task-1a",
      spec: {
        kind: "task",
        agent: "emploke/dev",
        brief: "Replace console.log calls in packages/catalog",
      },
      createdAt: iso(-1429),
      readyAt: iso(-1429),
      runningAt: iso(-1428),
      endedAt: iso(-1330),
    },
    {
      id: "wfn-log-task-1b",
      workflowId: "wf-succeeded-simple",
      status: "succeeded",
      phase: 1,
      taskId: "wf-task-log-task-1b",
      spec: {
        kind: "task",
        agent: "emploke/dev",
        brief: "Add structured-logger happy-path tests",
      },
      createdAt: iso(-1428),
      readyAt: iso(-1428),
      runningAt: iso(-1427),
      endedAt: iso(-1325),
    },
  ],
  edges: [
    { from: "wfn-log-coord-0", to: "wfn-log-task-1a" },
    { from: "wfn-log-coord-0", to: "wfn-log-task-1b" },
  ],
};

const dagFailedEarly: WorkflowDagWire = {
  workflow: fixtureWorkflows[2]!,
  nodes: [
    {
      id: "wfn-bump-coord-0",
      workflowId: "wf-failed-early",
      status: "failed",
      phase: 0,
      taskId: "wf-task-bump-coord-0",
      spec: { kind: "coordinator", agent: "emploke/dev" },
      createdAt: iso(-2880),
      readyAt: iso(-2880),
      runningAt: iso(-2880),
      endedAt: iso(-2820),
    },
  ],
  edges: [],
};

const dagCancelledLate: WorkflowDagWire = {
  workflow: fixtureWorkflows[3]!,
  nodes: [
    {
      id: "wfn-brand-coord-0",
      workflowId: "wf-cancelled-late",
      status: "succeeded",
      phase: 0,
      taskId: "wf-task-brand-coord-0",
      spec: { kind: "coordinator", agent: "emploke/designer" },
      createdAt: iso(-4320),
      readyAt: iso(-4320),
      runningAt: iso(-4320),
      endedAt: iso(-4300),
    },
    {
      id: "wfn-brand-task-1a",
      workflowId: "wf-cancelled-late",
      status: "cancelled",
      phase: 1,
      taskId: "wf-task-brand-task-1a",
      spec: {
        kind: "task",
        agent: "emploke/designer",
        brief: "Draft hero section copy + image layout",
      },
      createdAt: iso(-4299),
      readyAt: iso(-4299),
      runningAt: iso(-4298),
      endedAt: iso(-4200),
    },
  ],
  edges: [{ from: "wfn-brand-coord-0", to: "wfn-brand-task-1a" }],
};

export const fixtureWorkflowDags: ReadonlyMap<string, WorkflowDagWire> = new Map([
  [fixtureWorkflows[0]!.id, dagRunningMultistage],
  [fixtureWorkflows[1]!.id, dagSucceededSimple],
  [fixtureWorkflows[2]!.id, dagFailedEarly],
  [fixtureWorkflows[3]!.id, dagCancelledLate],
]);
