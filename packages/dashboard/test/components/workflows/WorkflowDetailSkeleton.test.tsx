import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowDetailSkeleton } from "../../../src/components/workflows/WorkflowDetailSkeleton";

afterEach(() => cleanup());

describe("WorkflowDetailSkeleton", () => {
  it("renders the skeleton aside", () => {
    render(<WorkflowDetailSkeleton />);
    expect(screen.getByTestId("workflow-detail-skeleton")).toBeTruthy();
  });

  it("exposes role=status + aria-busy + a polite live region", () => {
    render(<WorkflowDetailSkeleton />);
    const root = screen.getByTestId("workflow-detail-skeleton");
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.getAttribute("aria-label")).toBe("Loading workflow");
  });

  it("approximates all three regions (header, tabs, body) via .skeleton shapes", () => {
    render(<WorkflowDetailSkeleton />);
    // Header region: title + chips + statbar stats — all `.skeleton` blocks.
    expect(document.querySelector(".workflow-detail-skeleton__title")).toBeTruthy();
    expect(document.querySelectorAll(".workflow-detail-skeleton__chip").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".workflow-detail-skeleton__stat").length).toBeGreaterThan(0);
    // Tab strip region.
    expect(document.querySelectorAll(".workflow-detail-skeleton__tab").length).toBeGreaterThan(0);
    // Body region (the equivalent of the main DAG/activity area).
    expect(document.querySelectorAll(".workflow-detail-skeleton__line").length).toBeGreaterThan(0);
  });
});
