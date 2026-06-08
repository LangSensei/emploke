import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowHeaderWire } from "../../../src/api";
import { WorkflowListItem } from "../../../src/components/workflows/WorkflowListItem";

function makeWorkflow(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-default-123456",
    brief: "Default workflow",
    status: "running",
    coordinatorAgent: "emploke/dev",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    iterationCount: 2,
    ...overrides,
  };
}

function renderRow(overrides: Partial<WorkflowHeaderWire> = {}, selected = false) {
  const onSelect = vi.fn();
  const wf = makeWorkflow(overrides);
  render(
    <ul>
      <WorkflowListItem
        workflow={wf}
        selected={selected}
        onSelect={onSelect}
        posinset={1}
        setsize={1}
      />
    </ul>,
  );
  return { wf, onSelect };
}

afterEach(() => cleanup());

describe("WorkflowListItem — selection + click", () => {
  it("invokes onSelect when the row button is clicked", () => {
    const { wf, onSelect } = renderRow();
    fireEvent.click(screen.getByTestId(`workflow-row-${wf.id}`).querySelector("button")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("adds the selected modifier class + aria-current when selected", () => {
    const { wf } = renderRow({}, true);
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    expect(row.className).toContain("task-list__item--selected");
    const btn = row.querySelector("button");
    expect(btn?.getAttribute("aria-current")).toBe("true");
  });

  it("does not add the selected class when not selected", () => {
    const { wf } = renderRow({}, false);
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    expect(row.className).not.toContain("task-list__item--selected");
    expect(row.querySelector("button")?.getAttribute("aria-current")).toBeNull();
  });
});

describe("WorkflowListItem — meta rendering", () => {
  it("renders the short (8-char) id", () => {
    const { wf } = renderRow({ id: "wf-thisismorethan8chars" });
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    expect(row.textContent).toContain("wf-thisi");
    expect(row.textContent).not.toContain("wf-thisismorethan8chars");
  });

  it("renders the coordinator agent and iteration count", () => {
    const { wf } = renderRow({ coordinatorAgent: "emploke/review", iterationCount: 7 });
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    expect(row.textContent).toContain("emploke/review");
    expect(row.textContent).toContain("iter 7");
  });
});
