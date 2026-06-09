import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStatusBadge } from "../../../src/components/workflows/WorkflowStatusBadge";

afterEach(() => cleanup());

describe("WorkflowStatusBadge — tone mapping", () => {
  it("running maps to the info tone with a pulsing dot", () => {
    render(<WorkflowStatusBadge status="running" />);
    const badge = screen.getByTestId("workflow-status-badge-running");
    expect(badge.className).toContain("badge--info");
    expect(badge.className).toContain("badge--with-dot");
    const dot = badge.querySelector(".badge__dot");
    expect(dot?.className).toContain("badge__dot--pulse");
  });

  it("succeeded maps to the success tone without a pulsing dot", () => {
    render(<WorkflowStatusBadge status="succeeded" />);
    const badge = screen.getByTestId("workflow-status-badge-succeeded");
    expect(badge.className).toContain("badge--success");
    expect(badge.querySelector(".badge__dot")?.className ?? "").not.toContain("badge__dot--pulse");
  });

  it("failed maps to the danger tone", () => {
    render(<WorkflowStatusBadge status="failed" />);
    const badge = screen.getByTestId("workflow-status-badge-failed");
    expect(badge.className).toContain("badge--danger");
  });

  it("cancelled maps to the muted tone (parity with Tasks; avoids amber collision with Schedules PAUSED)", () => {
    render(<WorkflowStatusBadge status="cancelled" />);
    const badge = screen.getByTestId("workflow-status-badge-cancelled");
    expect(badge.className).toContain("badge--muted");
  });
});

describe("WorkflowStatusBadge — a11y wiring", () => {
  it("declares role='status' and aria-live='polite' so flips are announced", () => {
    render(<WorkflowStatusBadge status="running" />);
    const badge = screen.getByTestId("workflow-status-badge-running");
    expect(badge.getAttribute("role")).toBe("status");
    expect(badge.getAttribute("aria-live")).toBe("polite");
  });
});
