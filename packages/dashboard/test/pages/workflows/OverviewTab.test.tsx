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

describe("OverviewTab — Summary card", () => {
  it("renders success.output via Summary card for succeeded workflows", () => {
    render(
      <OverviewTab
        workflow={makeWf({
          status: "succeeded",
          success: { output: "## Done\nmigration applied" },
        })}
      />,
    );
    const summary = screen.getByTestId("workflow-overview-summary");
    expect(summary.textContent).toContain("Done");
    expect(summary.textContent).toContain("migration applied");
  });

  it("does NOT render the Summary card when success.output is empty / missing", () => {
    render(<OverviewTab workflow={makeWf({ status: "succeeded", success: { output: "" } })} />);
    expect(screen.queryByTestId("workflow-overview-summary")).toBeNull();
    expect(screen.getByTestId("workflow-overview-no-summary").textContent).toMatch(
      /no recorded summary/i,
    );
  });
});

describe("OverviewTab — Details card", () => {
  it("renders the details block when present", () => {
    render(<OverviewTab workflow={makeWf({ details: "step 1\nstep 2\nstep 3" })} />);
    expect(screen.getByTestId("workflow-overview-details").textContent).toContain("step 1");
  });

  it("omits the details block when details is empty / undefined", () => {
    // The brief itself is rendered by WorkflowView's title — OverviewTab
    // intentionally omits it to avoid the same string appearing twice.
    render(<OverviewTab workflow={makeWf()} />);
    expect(screen.queryByTestId("workflow-overview-details")).toBeNull();
  });
});

describe("OverviewTab — typed state strips", () => {
  it("renders a typed failure callout for status=failed with a failure payload", () => {
    render(
      <OverviewTab
        workflow={makeWf({
          status: "failed",
          failure: { kind: "coord", message: "coordinator returned non-zero" },
        })}
      />,
    );
    const callout = screen.getByTestId("workflow-overview-failure-callout");
    expect(callout.textContent).toContain("coord");
    expect(screen.getByTestId("workflow-overview-failure-message").textContent).toContain(
      "coordinator returned non-zero",
    );
  });

  it("renders a cancellation note for status=cancelled with a cancellation payload", () => {
    render(
      <OverviewTab
        workflow={makeWf({
          status: "cancelled",
          cancellation: { kind: "user", message: "no longer needed" },
        })}
      />,
    );
    expect(screen.getByTestId("workflow-overview-cancellation").textContent).toContain(
      "no longer needed",
    );
  });

  it("renders the legacy-row note for terminal rows with no payload column", () => {
    // Pre-v2.2 row: terminal status + NULL payload columns. The
    // Workflow detail pane MUST still render legibly — the note is
    // the operator's cue that this isn't a current-format row.
    render(<OverviewTab workflow={makeWf({ status: "failed" })} />);
    expect(screen.getByTestId("workflow-overview-legacy-note")).toBeTruthy();
  });

  it("renders the running hint for in-flight workflows", () => {
    render(<OverviewTab workflow={makeWf({ status: "running" })} />);
    expect(screen.getByTestId("workflow-overview-running-hint")).toBeTruthy();
  });
});

describe("OverviewTab — Metadata card", () => {
  it("renders metadata key/value rows when metadata is non-empty", () => {
    render(<OverviewTab workflow={makeWf({ metadata: { source: "cli", retry: 2 } })} />);
    const dl = screen.getByTestId("workflow-overview-metadata");
    expect(dl.textContent).toContain("source");
    expect(dl.textContent).toContain("cli");
    expect(dl.textContent).toContain("retry");
    expect(dl.textContent).toContain("2");
  });

  it("omits the Metadata card entirely when metadata is empty", () => {
    render(<OverviewTab workflow={makeWf({ metadata: {} })} />);
    expect(screen.queryByTestId("workflow-overview-metadata")).toBeNull();
  });
});
