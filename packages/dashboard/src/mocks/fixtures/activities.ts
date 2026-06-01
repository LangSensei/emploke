import type { TaskActivity } from "../../api/index.js";

/**
 * Per-task activity timelines for `/api/workspaces/:wsId/tasks/:tid/activity`.
 *
 * Only a handful of tasks carry a hand-authored timeline — the rest return
 * `{ activity: [], result: null, totalItems: 0 }` from the handler so the
 * Activity tab renders an empty-but-valid state.
 */
export const fixtureActivities: Record<string, TaskActivity> = {
  "running-with-activity": {
    activity: [
      {
        seq: 1,
        kind: "user",
        timestamp: "2026-05-27T22:00:01.000Z",
        text: "Designer mode: ship the MSW skeleton + fixtures and open PR-A.",
      },
      {
        seq: 2,
        kind: "thinking",
        timestamp: "2026-05-27T22:00:03.000Z",
        text: "Read api.ts to enumerate every fetch the dashboard makes.",
      },
      {
        seq: 3,
        kind: "tool_call",
        timestamp: "2026-05-27T22:00:05.000Z",
        callId: "tool-1",
        name: "view",
        args: { path: "/repo/packages/dashboard/src/api.ts" },
        status: "success",
        durationMs: 42,
      },
      {
        seq: 4,
        kind: "assistant",
        timestamp: "2026-05-27T22:00:09.000Z",
        text: "Found the canonical URL set. Generating handlers + fixtures.",
        model: "claude-opus-4.7",
      },
      {
        seq: 5,
        kind: "system",
        timestamp: "2026-05-27T22:00:11.000Z",
        text: "Polling /tasks for updates (cadence 5s).",
        level: "info",
      },
    ],
    result: null,
    totalItems: 5,
  },
  "single-html": {
    activity: [
      {
        seq: 1,
        kind: "user",
        timestamp: "2026-05-26T14:30:02.000Z",
        text: "Review the PR diff and write a summary to artifact/summary.html.",
      },
      {
        seq: 2,
        kind: "assistant",
        timestamp: "2026-05-26T14:33:55.000Z",
        text: "Review posted. See attached HTML summary.",
        model: "claude-opus-4.7",
        stopReason: "end_turn",
      },
      {
        seq: 3,
        kind: "summary",
        timestamp: "2026-05-26T14:34:11.000Z",
        text: "Review posted: 4 nits + 1 blocker.",
        stats: {
          toolCallsCount: 6,
          durationMs: 249_000,
          model: "claude-opus-4.7",
        },
      },
    ],
    result: "Review posted: 4 nits + 1 blocker.",
    totalItems: 3,
  },
  "no-artifacts": {
    activity: [
      {
        seq: 1,
        kind: "user",
        timestamp: "2026-05-24T18:00:00.250Z",
        text: "Reproduce the flake in TasksFilters.test.tsx and write a fix.",
      },
      {
        seq: 2,
        kind: "tool_call",
        timestamp: "2026-05-24T18:00:30.000Z",
        callId: "tool-1",
        name: "powershell",
        args: { command: "pnpm -F @emploke/dashboard test" },
        status: "error",
        result: { exitCode: 1 },
        durationMs: 150_000,
      },
      {
        seq: 3,
        kind: "system",
        timestamp: "2026-05-24T18:02:30.000Z",
        text: "Vitest exited with code 1 (3 tests failing).",
        level: "error",
      },
    ],
    result: null,
    totalItems: 3,
  },
};
