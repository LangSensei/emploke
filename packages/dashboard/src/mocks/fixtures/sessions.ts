import type { SessionView } from "../../api.js";

export const fixtureSessions: SessionView[] = [
  {
    id: "sess-dev-1",
    workdir: "/mock/workspaces/designer/sessions/sess-dev-1",
    agent: "emploke/dev",
    runtime: "copilot",
    runtimeSessionId: "copilot-rt-abc123",
    createdAt: "2026-05-26T12:00:00.000Z",
    lastActiveAt: "2026-05-26T12:45:00.000Z",
    preview: "Investigated #212 designer mode and outlined the MSW plan.",
    lastLaunchMode: "local",
  },
  {
    id: "sess-review-1",
    workdir: "/mock/workspaces/designer/sessions/sess-review-1",
    agent: "emploke/review",
    runtime: "claude",
    runtimeSessionId: null,
    createdAt: "2026-05-25T14:10:00.000Z",
    lastActiveAt: null,
    preview: null,
    lastLaunchMode: "remote",
  },
  {
    id: "sess-designer-pending",
    workdir: "/mock/workspaces/designer/sessions/sess-designer-pending",
    agent: "emploke/designer",
    runtime: "copilot",
    runtimeSessionId: null,
    createdAt: "2026-05-24T10:00:00.000Z",
    lastActiveAt: "2026-05-24T10:05:00.000Z",
    preview: "Spawned but blocked on prereqs ack.",
    lastLaunchMode: null,
  },
];
