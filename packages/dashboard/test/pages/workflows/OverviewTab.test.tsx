import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowHeaderWire } from "../../../src/api";
import { OverviewTab } from "../../../src/pages/workflows/OverviewTab";

function makeWf(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-1",
    brief: "Default brief",
    status: "running",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    iterationCount: 0,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("OverviewTab", () => {
  it("renders the brief", () => {
    render(<OverviewTab workflow={makeWf({ brief: "Migrate auth" })} />);
    expect(screen.getByTestId("workflow-overview-brief").textContent).toBe("Migrate auth");
  });

  it("renders the details block when present", () => {
    render(<OverviewTab workflow={makeWf({ details: "step 1\nstep 2\nstep 3" })} />);
    expect(screen.getByTestId("workflow-overview-details").textContent).toContain("step 1");
  });

  it("omits the details block when details is empty / undefined", () => {
    render(<OverviewTab workflow={makeWf()} />);
    expect(screen.queryByTestId("workflow-overview-details")).toBeNull();
  });

  it("renders the outcome banner for terminal-non-succeeded statuses", () => {
    render(<OverviewTab workflow={makeWf({ status: "failed" })} />);
    expect(screen.getByTestId("workflow-overview-outcome").textContent).toContain("Outcome");
  });

  it("does not render the outcome banner for running / succeeded", () => {
    const { rerender } = render(<OverviewTab workflow={makeWf({ status: "running" })} />);
    expect(screen.queryByTestId("workflow-overview-outcome")).toBeNull();
    rerender(<OverviewTab workflow={makeWf({ status: "succeeded" })} />);
    expect(screen.queryByTestId("workflow-overview-outcome")).toBeNull();
  });

  it("renders metadata key/value rows when metadata is non-empty", () => {
    render(<OverviewTab workflow={makeWf({ metadata: { source: "cli", retry: 2 } })} />);
    const dl = screen.getByTestId("workflow-overview-metadata");
    expect(dl.textContent).toContain("source");
    expect(dl.textContent).toContain("cli");
    expect(dl.textContent).toContain("retry");
    expect(dl.textContent).toContain("2");
  });
});
