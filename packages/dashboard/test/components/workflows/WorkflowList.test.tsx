import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowHeaderWire } from "../../../src/api";
import { WorkflowList } from "../../../src/components/workflows/WorkflowList";

function makeWorkflow(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-default",
    brief: "Default workflow",
    status: "running",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    iterationCount: 0,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("WorkflowList — explicit role='list'", () => {
  it("the root <ul> carries an explicit role='list' attribute and aria-label='Workflows'", () => {
    render(
      <WorkflowList
        workflows={[makeWorkflow({ id: "wf-1", brief: "One" })]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    const list = screen.getByRole("list", { name: /workflows/i });
    expect(list.tagName).toBe("UL");
    expect(list.getAttribute("role")).toBe("list");
  });
});

describe("WorkflowList — aria-posinset / aria-setsize across rows", () => {
  it("each <li> is numbered 1..N with the same setsize matching the total", () => {
    const workflows = [
      makeWorkflow({ id: "wf-1", brief: "One" }),
      makeWorkflow({ id: "wf-2", brief: "Two" }),
      makeWorkflow({ id: "wf-3", brief: "Three" }),
    ];
    render(<WorkflowList workflows={workflows} selectedId={null} onSelect={vi.fn()} />);
    const list = screen.getByRole("list", { name: /workflows/i });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(items[1]?.getAttribute("aria-posinset")).toBe("2");
    expect(items[2]?.getAttribute("aria-posinset")).toBe("3");
    for (const li of items) {
      expect(li.getAttribute("aria-setsize")).toBe("3");
    }
  });
});
