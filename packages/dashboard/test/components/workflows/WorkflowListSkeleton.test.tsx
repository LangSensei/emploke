import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowListSkeleton } from "../../../src/components/workflows/WorkflowListSkeleton";

afterEach(() => cleanup());

describe("WorkflowListSkeleton", () => {
  it("renders 4 placeholder rows by default", () => {
    render(<WorkflowListSkeleton />);
    expect(screen.getByTestId("workflow-list-skeleton")).toBeTruthy();
    expect(screen.getAllByTestId("workflow-list-skeleton-row")).toHaveLength(4);
  });

  it("accepts a rowCount override", () => {
    render(<WorkflowListSkeleton rowCount={2} />);
    expect(screen.getAllByTestId("workflow-list-skeleton-row")).toHaveLength(2);
  });

  it("exposes aria-busy=true + role=status so screen readers announce the loading state", () => {
    render(<WorkflowListSkeleton />);
    const root = screen.getByTestId("workflow-list-skeleton");
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.getAttribute("aria-label")).toBe("Loading workflows");
  });

  it("uses the shared .skeleton shimmer class so no new animation primitive is introduced", () => {
    render(<WorkflowListSkeleton rowCount={1} />);
    // Each placeholder bar inside the row carries the shared `.skeleton` class.
    expect(document.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });
});
