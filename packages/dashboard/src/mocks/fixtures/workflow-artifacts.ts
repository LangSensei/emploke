import type { WorkflowArtifactWire } from "../../api";
import { fixtureWorkflowMockIds } from "./workflows";

/**
 * Designer-mode fixtures for the workflow Artifacts tab.
 *
 * Keyed by workflow id (`20260608-1f3a7b9c`, …) and laid out to
 * cover the four interesting list shapes:
 *
 *   - `20260608-1f3a7b9c` — workflow-summary entries (one md +
 *     one png) + per-node entries for the running phase-3 task.
 *   - `20260607-2e4b8cad`   — per-node entries for both phase-1
 *     workers; no curated workflow-summary content.
 *   - `20260606-3d5c9dbe`       — empty (`[]`), exercising the empty
 *     state in the Artifacts tab.
 *   - `20260605-4e6dabcf`     — workflow-summary entry only (the
 *     coordinator left a final report.md before cancel).
 *
 * Per-node `nodeId` + `taskId` values are pulled from the shared
 * `fixtureWorkflowMockIds` map exported by `workflows.ts` so the
 * Artifacts tab resolves against the same UUIDv4 / dated-hex ids
 * used by `WorkflowNodeWire.id` / `WorkflowNodeWire.taskId`. A
 * rename in `workflows.ts` propagates automatically.
 *
 * `modifiedAt` timestamps are inline-pinned for stable snapshots.
 */
const { nodes: N, tasks: T } = fixtureWorkflowMockIds;
const EPOCH = Date.parse("2026-05-28T00:00:00.000Z");
const iso = (offsetMinutes: number): string =>
  new Date(EPOCH + offsetMinutes * 60_000).toISOString();

export const fixtureWorkflowArtifacts: ReadonlyMap<string, readonly WorkflowArtifactWire[]> =
  new Map([
    [
      "20260608-1f3a7b9c",
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
          nodeId: N.migTask1a,
          taskId: T.migTask1a,
          path: "diff-summary.md",
          size: 2410,
          modifiedAt: iso(-90),
          mimeBucket: "text",
        },
        {
          kind: "node",
          nodeId: N.migTask1a,
          taskId: T.migTask1a,
          path: "logs.txt",
          size: 18_990,
          modifiedAt: iso(-90),
          mimeBucket: "text",
        },
      ] as readonly WorkflowArtifactWire[],
    ],
    [
      "20260607-2e4b8cad",
      [
        {
          kind: "node",
          nodeId: N.logTask1a,
          taskId: T.logTask1a,
          path: "patch.md",
          size: 6321,
          modifiedAt: iso(-1330),
          mimeBucket: "text",
        },
        {
          kind: "node",
          nodeId: N.logTask1b,
          taskId: T.logTask1b,
          path: "test-output.json",
          size: 1011,
          modifiedAt: iso(-1325),
          mimeBucket: "text",
        },
      ] as readonly WorkflowArtifactWire[],
    ],
    ["20260606-3d5c9dbe", [] as readonly WorkflowArtifactWire[]],
    [
      "20260605-4e6dabcf",
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
