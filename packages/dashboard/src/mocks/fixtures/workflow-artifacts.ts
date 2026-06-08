import type { WorkflowArtifactWire } from "../../api";

/**
 * Designer-mode fixtures for the workflow Artifacts tab.
 *
 * Keyed by workflow id (`wf-running-multistage`, …) and laid out to
 * cover the four interesting list shapes:
 *
 *   - `wf-running-multistage` — workflow-summary entries (one md +
 *     one png) + per-node entries for the running phase-3 task.
 *   - `wf-succeeded-simple`   — per-node entries for both phase-1
 *     workers; no curated workflow-summary content.
 *   - `wf-failed-early`       — empty (`[]`), exercising the empty
 *     state in the Artifacts tab.
 *   - `wf-cancelled-late`     — workflow-summary entry only (the
 *     coordinator left a final report.md before cancel).
 *
 * Per-node `taskId` keys match the synthetic `wf-task-*` ids on the
 * matching `WorkflowNodeWire.taskId` in `fixtureWorkflowDags` so a
 * future "Open as task" navigation can resolve a real fixture.
 *
 * `modifiedAt` timestamps are inline-pinned for stable snapshots.
 */
const EPOCH = Date.parse("2026-05-28T00:00:00.000Z");
const iso = (offsetMinutes: number): string =>
  new Date(EPOCH + offsetMinutes * 60_000).toISOString();

export const fixtureWorkflowArtifacts: ReadonlyMap<string, readonly WorkflowArtifactWire[]> =
  new Map([
    [
      "wf-running-multistage",
      [
        {
          kind: "workflow-summary",
          path: "report.md",
          size: 4123,
          modifiedAt: iso(-65),
          mimeBucket: "text",
        },
        {
          kind: "workflow-summary",
          path: "snapshots/phase-2-summary.png",
          size: 38_117,
          modifiedAt: iso(-70),
          mimeBucket: "image",
        },
        {
          kind: "node",
          nodeId: "wfn-mig-task-1a",
          taskId: "wf-task-mig-task-1a",
          path: "diff-summary.md",
          size: 2410,
          modifiedAt: iso(-90),
          mimeBucket: "text",
        },
        {
          kind: "node",
          nodeId: "wfn-mig-task-1a",
          taskId: "wf-task-mig-task-1a",
          path: "logs.txt",
          size: 18_990,
          modifiedAt: iso(-90),
          mimeBucket: "text",
        },
      ] as readonly WorkflowArtifactWire[],
    ],
    [
      "wf-succeeded-simple",
      [
        {
          kind: "node",
          nodeId: "wfn-log-task-1a",
          taskId: "wf-task-log-task-1a",
          path: "patch.md",
          size: 6321,
          modifiedAt: iso(-1330),
          mimeBucket: "text",
        },
        {
          kind: "node",
          nodeId: "wfn-log-task-1b",
          taskId: "wf-task-log-task-1b",
          path: "test-output.json",
          size: 1011,
          modifiedAt: iso(-1325),
          mimeBucket: "text",
        },
      ] as readonly WorkflowArtifactWire[],
    ],
    ["wf-failed-early", [] as readonly WorkflowArtifactWire[]],
    [
      "wf-cancelled-late",
      [
        {
          kind: "workflow-summary",
          path: "final-report.md",
          size: 980,
          modifiedAt: iso(-4200),
          mimeBucket: "text",
        },
      ] as readonly WorkflowArtifactWire[],
    ],
  ]);
