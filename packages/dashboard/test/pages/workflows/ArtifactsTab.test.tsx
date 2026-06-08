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
  // jsdom's `fetch` polyfill differs across versions — stub a 404 so
  // the preview pane lands in a deterministic state for tests that
  // don't care about the body bytes.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }) as unknown as Response,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ArtifactsTab — empty + error states", () => {
  it("renders an empty state when the workflow has no artifacts", async () => {
    mockListWorkflowArtifacts.mockResolvedValue({ artifacts: [] } as WorkflowArtifactsResponse);
    render(<ArtifactsTab workflow={makeWf()} dag={null} />);
    await waitFor(() => {
      expect(screen.getByTestId("workflow-artifacts-empty")).toBeTruthy();
    });
  });

  it("renders an error banner when the list fetch fails", async () => {
    mockListWorkflowArtifacts.mockRejectedValue(new Error("boom"));
    render(<ArtifactsTab workflow={makeWf()} dag={null} />);
    await waitFor(() => {
      expect(screen.getByTestId("workflow-artifacts-error").textContent).toContain("boom");
    });
  });
});

describe("ArtifactsTab — dropdown UX", () => {
  it("renders a <select> with `<optgroup>` per source (Summary + per-node)", async () => {
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
      expect(screen.getByTestId("workflow-artifacts-selector")).toBeTruthy();
    });
    const select = screen.getByTestId("workflow-artifacts-selector") as HTMLSelectElement;
    const optgroups = select.querySelectorAll("optgroup");
    expect(optgroups.length).toBe(2);
    const labels = Array.from(optgroups).map((og) => og.getAttribute("label"));
    expect(labels[0]).toBe("Summary");
    // Without a DAG we cannot resolve agent labels, so the per-node
    // group falls back to "Node <shortId>".
    expect(labels[1]).toMatch(/^Node n-a/);
  });

  it("v2.3: trims trailing dashes from the 8-char short id in the node group label", async () => {
    // Regression guard for v2.3. When a nodeId's 8-char window
    // lands on a `-` separator (e.g. `n-12345-extra` -> short
    // `n-12345-`), the dangling dash made the label read as
    // `Node n-12345-` with no visible character after it. Trim
    // trailing dashes off the short slice so the label always ends
    // on a glyph.
    mockListWorkflowArtifacts.mockResolvedValue({
      artifacts: [
        {
          kind: "node",
          nodeId: "n-12345-extra-bytes-here",
          taskId: "t-x",
          path: "logs.txt",
          size: 200,
          modifiedAt: "2026-05-28T00:00:00.000Z",
          mimeBucket: "text",
        },
      ],
    } as WorkflowArtifactsResponse);

    render(<ArtifactsTab workflow={makeWf()} dag={null} />);
    await waitFor(() => {
      expect(screen.getByTestId("workflow-artifacts-selector")).toBeTruthy();
    });
    const select = screen.getByTestId("workflow-artifacts-selector") as HTMLSelectElement;
    const optgroup = select.querySelector("optgroup");
    const label = optgroup?.getAttribute("label") ?? "";
    expect(label).toBe("Node n-12345");
    expect(label.endsWith("-")).toBe(false);
  });

  it("auto-selects the first artifact on mount and renders a download link to it", async () => {
    mockListWorkflowArtifacts.mockResolvedValue({
      artifacts: [
        {
          kind: "workflow-summary",
          path: "report.md",
          size: 100,
          modifiedAt: "2026-05-28T00:00:00.000Z",
          mimeBucket: "text",
        },
      ],
    } as WorkflowArtifactsResponse);

    render(<ArtifactsTab workflow={makeWf()} dag={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("workflow-artifacts-selector")).toBeTruthy();
    });
    const select = screen.getByTestId("workflow-artifacts-selector") as HTMLSelectElement;
    expect(select.value).toBe("summary/report.md");
    const download = select.closest("header")?.querySelector("a.artifacts-pane__download");
    expect(download?.getAttribute("href")).toBe("/api/wf/wf-1/summary%2Freport.md");
    expect(download?.getAttribute("download")).toBe("report.md");
  });

  it("renders the preview pane container regardless of fetch outcome", async () => {
    mockListWorkflowArtifacts.mockResolvedValue({
      artifacts: [
        {
          kind: "workflow-summary",
          path: "report.md",
          size: 100,
          modifiedAt: "2026-05-28T00:00:00.000Z",
          mimeBucket: "text",
        },
      ],
    } as WorkflowArtifactsResponse);

    render(<ArtifactsTab workflow={makeWf()} dag={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("workflow-artifacts-preview")).toBeTruthy();
    });
  });
});
