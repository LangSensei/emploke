import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowArtifactsResponse, WorkflowHeaderWire } from "../../../src/api";

vi.mock("../../../src/api", async () => {
  const actual = await vi.importActual<typeof import("../../../src/api")>("../../../src/api");
  return {
    ...actual,
    listWorkflowArtifacts: vi.fn(),
    workflowArtifactUrl: (id: string, subPath: string) =>
      `/api/wf/${id}/${encodeURIComponent(subPath)}`,
  };
});

// Stub the markdown renderer so we don't fetch over the network when
// asserting the artifact card structure.
vi.mock("../../../src/components/tasks/TaskDetail/MarkdownSummary", () => ({
  MarkdownSummary: ({ source }: { source: string }) => <div data-testid="md">{source}</div>,
}));

import * as api from "../../../src/api";
import { ArtifactsTab } from "../../../src/pages/workflows/ArtifactsTab";

const mockListWorkflowArtifacts = api.listWorkflowArtifacts as unknown as ReturnType<typeof vi.fn>;

function makeWf(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-1",
    brief: "x",
    status: "succeeded",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    iterationCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockListWorkflowArtifacts.mockReset();
});

afterEach(() => cleanup());

describe("ArtifactsTab", () => {
  it("renders an empty state when the workflow has no artifacts", async () => {
    mockListWorkflowArtifacts.mockResolvedValue({ artifacts: [] } as WorkflowArtifactsResponse);
    render(<ArtifactsTab workflow={makeWf()} dag={null} />);
    await waitFor(() => {
      expect(screen.getByTestId("workflow-artifacts-empty")).toBeTruthy();
    });
  });

  it("renders summary + per-node sections from the list response", async () => {
    mockListWorkflowArtifacts.mockResolvedValue({
      artifacts: [
        {
          kind: "workflow-summary",
          path: "report.md",
          size: 100,
          modifiedAt: "2026-05-28T00:00:00.000Z",
          mimeBucket: "text",
        },
        {
          kind: "node",
          nodeId: "n-a",
          taskId: "t-a",
          path: "logs.txt",
          size: 200,
          modifiedAt: "2026-05-28T00:00:00.000Z",
          mimeBucket: "text",
        },
      ],
    } as WorkflowArtifactsResponse);

    render(<ArtifactsTab workflow={makeWf()} dag={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("workflow-artifacts-summary")).toBeTruthy();
    });
    expect(screen.getByTestId("workflow-artifacts-node-n-a")).toBeTruthy();
    // The summary section uses the `summary/` URL prefix.
    expect(
      screen
        .getByTestId("workflow-artifacts-summary")
        .querySelector("a.workflow-artifacts__download")
        ?.getAttribute("href"),
    ).toBe("/api/wf/wf-1/summary%2Freport.md");
  });

  it("renders an error banner when the list fetch fails", async () => {
    mockListWorkflowArtifacts.mockRejectedValue(new Error("boom"));
    render(<ArtifactsTab workflow={makeWf()} dag={null} />);
    await waitFor(() => {
      expect(screen.getByTestId("workflow-artifacts-error").textContent).toContain("boom");
    });
  });
});
