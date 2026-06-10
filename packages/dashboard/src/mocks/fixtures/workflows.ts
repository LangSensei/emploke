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

/**
 * Hand-authored UUIDv4 node ids. Must satisfy `assertValidWorkflowNodeId`'s
 * UUIDv4 grammar (see `@emploke/workflow`'s `validate.ts` UUID_V4_RE) AND
 * stay stable across snapshot tests — that's why these are pre-baked
 * constants rather than `randomUUID()` calls at module load. Each id's
 * first 8 hex chars are unique within its workflow so the DAG short-id
 * chip in `WorkflowDagView` renders distinct labels.
 *
 * Cross-file refs: `workflow-artifacts.ts` keys `node` artifacts by the
 * same UUIDs, and `tasks.ts` references them via `metadata.workflowNodeId`.
 * Keep all three files in sync when changing a node id.
 */
const NODE_ID_MIG_COORD_0 = "c000aaaa-1f3a-4b9c-8a00-20260608c000";
const NODE_ID_MIG_TASK_1A = "c1a1aaaa-1f3a-4b9c-9a01-20260608c1a0";
const NODE_ID_MIG_COORD_2 = "c002aaaa-1f3a-4b9c-8a02-20260608c002";
const NODE_ID_MIG_TASK_3A = "c3a3aaaa-1f3a-4b9c-9a03-20260608c3a0";
const NODE_ID_LOG_COORD_0 = "c000bbbb-2e4b-4cad-8b00-20260607c000";
const NODE_ID_LOG_TASK_1A = "c1a1bbbb-2e4b-4cad-9b01-20260607c1a0";
const NODE_ID_LOG_TASK_1B = "c1b1bbbb-2e4b-4cad-9b01-20260607c1b0";
const NODE_ID_BUMP_COORD_0 = "c000cccc-3d5c-4dbe-8c00-20260606c000";
const NODE_ID_BRAND_COORD_0 = "c000dddd-4e6d-4abc-8d00-20260605c000";
const NODE_ID_BRAND_TASK_1A = "c1a1dddd-4e6d-4abc-9d01-20260605c1a0";

/**
 * Hand-authored task ids in the real `<YYYYMMDD>-<8hex>` shape
 * (`generateTaskId` / `generateWorkflowId`). Date prefix mirrors the
 * surrounding workflow's id-date so screenshots are visually coherent.
 * Cross-referenced from `tasks.ts` (record `id` + `workdir`) and
 * `workflow-artifacts.ts` (per-node `taskId`); keep all three in sync.
 */
const TASK_ID_MIG_COORD_0 = "20260608-c0000000";
const TASK_ID_MIG_TASK_1A = "20260608-71a00001";
const TASK_ID_MIG_COORD_2 = "20260608-c0000002";
const TASK_ID_MIG_TASK_3A = "20260608-73a00003";
const TASK_ID_LOG_COORD_0 = "20260607-c0000000";
const TASK_ID_LOG_TASK_1A = "20260607-71a00001";
const TASK_ID_LOG_TASK_1B = "20260607-71b00001";
const TASK_ID_BUMP_COORD_0 = "20260606-c0000000";
const TASK_ID_BRAND_COORD_0 = "20260605-c0000000";
const TASK_ID_BRAND_TASK_1A = "20260605-71a00001";

export const fixtureWorkflowMockIds = {
  nodes: {
    migCoord0: NODE_ID_MIG_COORD_0,
    migTask1a: NODE_ID_MIG_TASK_1A,
    migCoord2: NODE_ID_MIG_COORD_2,
    migTask3a: NODE_ID_MIG_TASK_3A,
    logCoord0: NODE_ID_LOG_COORD_0,
    logTask1a: NODE_ID_LOG_TASK_1A,
    logTask1b: NODE_ID_LOG_TASK_1B,
    bumpCoord0: NODE_ID_BUMP_COORD_0,
    brandCoord0: NODE_ID_BRAND_COORD_0,
    brandTask1a: NODE_ID_BRAND_TASK_1A,
  },
  tasks: {
    migCoord0: TASK_ID_MIG_COORD_0,
    migTask1a: TASK_ID_MIG_TASK_1A,
    migCoord2: TASK_ID_MIG_COORD_2,
    migTask3a: TASK_ID_MIG_TASK_3A,
    logCoord0: TASK_ID_LOG_COORD_0,
    logTask1a: TASK_ID_LOG_TASK_1A,
    logTask1b: TASK_ID_LOG_TASK_1B,
    bumpCoord0: TASK_ID_BUMP_COORD_0,
    brandCoord0: TASK_ID_BRAND_COORD_0,
    brandTask1a: TASK_ID_BRAND_TASK_1A,
  },
} as const;

export const fixtureWorkflows: readonly WorkflowHeaderWire[] = [
  {
    id: "20260608-1f3a7b9c",
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
    id: "20260607-2e4b8cad",
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
    id: "20260606-3d5c9dbe",
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
    id: "20260605-4e6dabcf",
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
      id: NODE_ID_MIG_COORD_0,
      workflowId: "20260608-1f3a7b9c",
      status: "succeeded",
      phase: 0,
      taskId: TASK_ID_MIG_COORD_0,
      spec: { kind: "coordinator", agent: "emploke/dev" },
      metadata: {},
      createdAt: iso(-180),
      readyAt: iso(-180),
      runningAt: iso(-180),
      endedAt: iso(-160),
    },
    {
      id: NODE_ID_MIG_TASK_1A,
      workflowId: "20260608-1f3a7b9c",
      status: "succeeded",
      phase: 1,
      taskId: TASK_ID_MIG_TASK_1A,
      spec: {
        kind: "worker",
        agent: "emploke/dev",
        brief: "Replace session middleware with OAuth in packages/server",
        runtime: "copilot",
      },
      metadata: {},
      createdAt: iso(-159),
      readyAt: iso(-159),
      runningAt: iso(-158),
      endedAt: iso(-90),
    },
    {
      id: NODE_ID_MIG_COORD_2,
      workflowId: "20260608-1f3a7b9c",
      status: "succeeded",
      phase: 2,
      taskId: TASK_ID_MIG_COORD_2,
      spec: { kind: "coordinator", agent: "emploke/dev" },
      metadata: {},
      createdAt: iso(-89),
      readyAt: iso(-89),
      runningAt: iso(-89),
      endedAt: iso(-70),
    },
    {
      id: NODE_ID_MIG_TASK_3A,
      workflowId: "20260608-1f3a7b9c",
      status: "running",
      phase: 3,
      taskId: TASK_ID_MIG_TASK_3A,
      spec: {
        kind: "worker",
        agent: "emploke/review",
        brief: "Run the auth integration suite + summarise failures",
        runtime: "claude",
      },
      metadata: {},
      createdAt: iso(-69),
      readyAt: iso(-69),
      runningAt: iso(-68),
    },
  ],
  edges: [
    { from: NODE_ID_MIG_COORD_0, to: NODE_ID_MIG_TASK_1A },
    { from: NODE_ID_MIG_TASK_1A, to: NODE_ID_MIG_COORD_2 },
    { from: NODE_ID_MIG_COORD_2, to: NODE_ID_MIG_TASK_3A },
  ],
};

const dagSucceededSimple: WorkflowDagWire = {
  workflow: fixtureWorkflows[1]!,
  nodes: [
    {
      id: NODE_ID_LOG_COORD_0,
      workflowId: "20260607-2e4b8cad",
      status: "succeeded",
      phase: 0,
      taskId: TASK_ID_LOG_COORD_0,
      spec: { kind: "coordinator", agent: "emploke/review" },
      metadata: {},
      createdAt: iso(-1440),
      readyAt: iso(-1440),
      runningAt: iso(-1440),
      endedAt: iso(-1430),
    },
    {
      id: NODE_ID_LOG_TASK_1A,
      workflowId: "20260607-2e4b8cad",
      status: "succeeded",
      phase: 1,
      taskId: TASK_ID_LOG_TASK_1A,
      spec: {
        kind: "worker",
        agent: "emploke/dev",
        brief: "Replace console.log calls in packages/catalog",
      },
      metadata: {},
      createdAt: iso(-1429),
      readyAt: iso(-1429),
      runningAt: iso(-1428),
      endedAt: iso(-1330),
    },
    {
      id: NODE_ID_LOG_TASK_1B,
      workflowId: "20260607-2e4b8cad",
      status: "succeeded",
      phase: 1,
      taskId: TASK_ID_LOG_TASK_1B,
      spec: {
        kind: "worker",
        agent: "emploke/dev",
        brief: "Add structured-logger happy-path tests",
      },
      metadata: {},
      createdAt: iso(-1428),
      readyAt: iso(-1428),
      runningAt: iso(-1427),
      endedAt: iso(-1325),
    },
  ],
  edges: [
    { from: NODE_ID_LOG_COORD_0, to: NODE_ID_LOG_TASK_1A },
    { from: NODE_ID_LOG_COORD_0, to: NODE_ID_LOG_TASK_1B },
  ],
};

const dagFailedEarly: WorkflowDagWire = {
  workflow: fixtureWorkflows[2]!,
  nodes: [
    {
      id: NODE_ID_BUMP_COORD_0,
      workflowId: "20260606-3d5c9dbe",
      status: "failed",
      phase: 0,
      taskId: TASK_ID_BUMP_COORD_0,
      spec: { kind: "coordinator", agent: "emploke/dev" },
      metadata: {},
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
      id: NODE_ID_BRAND_COORD_0,
      workflowId: "20260605-4e6dabcf",
      status: "succeeded",
      phase: 0,
      taskId: TASK_ID_BRAND_COORD_0,
      spec: { kind: "coordinator", agent: "emploke/designer" },
      metadata: {},
      createdAt: iso(-4320),
      readyAt: iso(-4320),
      runningAt: iso(-4320),
      endedAt: iso(-4300),
    },
    {
      id: NODE_ID_BRAND_TASK_1A,
      workflowId: "20260605-4e6dabcf",
      status: "cancelled",
      phase: 1,
      taskId: TASK_ID_BRAND_TASK_1A,
      spec: {
        kind: "worker",
        agent: "emploke/designer",
        brief: "Draft hero section copy + image layout",
      },
      metadata: {},
      createdAt: iso(-4299),
      readyAt: iso(-4299),
      runningAt: iso(-4298),
      endedAt: iso(-4200),
    },
  ],
  edges: [{ from: NODE_ID_BRAND_COORD_0, to: NODE_ID_BRAND_TASK_1A }],
};

export const fixtureWorkflowDags: ReadonlyMap<string, WorkflowDagWire> = new Map([
  [fixtureWorkflows[0]!.id, dagRunningMultistage],
  [fixtureWorkflows[1]!.id, dagSucceededSimple],
  [fixtureWorkflows[2]!.id, dagFailedEarly],
  [fixtureWorkflows[3]!.id, dagCancelledLate],
]);
