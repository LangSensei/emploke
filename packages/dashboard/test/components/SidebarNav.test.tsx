import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type RuntimeChildId,
  type SectionDef,
  type SectionId,
  Sidebar,
  type SidebarItemId,
} from "../../src/components/Sidebar";

const SECTIONS: SectionDef[] = [
  { id: "overview", label: "Overview" },
  {
    id: "runtime",
    label: "Runtime",
    children: [
      { id: "agents", label: "Agents" },
      { id: "sessions", label: "Sessions" },
      { id: "tasks", label: "Tasks" },
      { id: "schedules", label: "Schedules" },
    ],
  },
  { id: "catalog", label: "Catalog" },
  { id: "settings", label: "Settings" },
];

interface RenderOpts {
  active: SidebarItemId;
}

function renderSidebar(opts: RenderOpts) {
  const onSelect = vi.fn<(id: SectionId) => void>();
  const onSelectRuntimeChild = vi.fn<(id: RuntimeChildId) => void>();
  const result = render(
    <MemoryRouter initialEntries={["/workspaces/ws-1/runtime/agents"]}>
      <Sidebar
        sections={SECTIONS}
        active={opts.active}
        onSelect={onSelect}
        onSelectRuntimeChild={onSelectRuntimeChild}
        workspaces={[]}
        currentWorkspaceId={null}
        onSelectWorkspace={() => {}}
        onAddWorkspace={() => {}}
        onRenameWorkspace={async () => {}}
      />
    </MemoryRouter>,
  );
  return { ...result, onSelect, onSelectRuntimeChild };
}

afterEach(() => cleanup());

describe("Sidebar nested Runtime children (Phase 1.5 Block F, §4.1)", () => {
  it("renders Sessions, Tasks, and Schedules under the Runtime group", () => {
    renderSidebar({ active: "runtime:agents" });

    // The Runtime parent button is still present at the top level.
    expect(screen.getByRole("button", { name: /^Runtime$/ })).toBeTruthy();

    // The four children render inside an Agents/Sessions/Tasks/Schedules sub-nav,
    // each as its own button so the parent owns top-level navigation
    // while the children own per-page navigation.
    const agentsChild = screen.getByRole("button", { name: /^Agents$/ });
    const sessionsChild = screen.getByRole("button", { name: /^Sessions$/ });
    const tasksChild = screen.getByRole("button", { name: /^Tasks$/ });
    const schedulesChild = screen.getByRole("button", { name: /^Schedules$/ });
    expect(agentsChild).toBeTruthy();
    expect(sessionsChild).toBeTruthy();
    expect(tasksChild).toBeTruthy();
    expect(schedulesChild).toBeTruthy();

    // All four children live under a single sub-nav <ul> labelled
    // after their parent — confirming the nesting (not four more
    // top-level rows).
    const subnav = screen.getByLabelText(/Runtime sub-navigation/i);
    expect(subnav.tagName.toLowerCase()).toBe("ul");
    expect(subnav.contains(agentsChild)).toBe(true);
    expect(subnav.contains(sessionsChild)).toBe(true);
    expect(subnav.contains(tasksChild)).toBe(true);
    expect(subnav.contains(schedulesChild)).toBe(true);
  });

  it("highlights exactly one Runtime child at a time", () => {
    function SidebarHarness({ active }: { active: SidebarItemId }) {
      return (
        <MemoryRouter initialEntries={["/workspaces/ws-1/runtime/agents"]}>
          <Sidebar
            sections={SECTIONS}
            active={active}
            onSelect={() => {}}
            onSelectRuntimeChild={() => {}}
            workspaces={[]}
            currentWorkspaceId={null}
            onSelectWorkspace={() => {}}
            onAddWorkspace={() => {}}
            onRenameWorkspace={async () => {}}
          />
        </MemoryRouter>
      );
    }

    const { rerender } = render(<SidebarHarness active="runtime:agents" />);
    let active = document.querySelectorAll(".sidebar__item--active");
    expect(active.length).toBe(1);
    expect(active[0].textContent).toMatch(/Agents/);

    rerender(<SidebarHarness active="runtime:sessions" />);
    active = document.querySelectorAll(".sidebar__item--active");
    expect(active.length).toBe(1);
    expect(active[0].textContent).toMatch(/Sessions/);

    rerender(<SidebarHarness active="runtime:tasks" />);
    active = document.querySelectorAll(".sidebar__item--active");
    expect(active.length).toBe(1);
    expect(active[0].textContent).toMatch(/Tasks/);

    rerender(<SidebarHarness active="runtime:schedules" />);
    active = document.querySelectorAll(".sidebar__item--active");
    expect(active.length).toBe(1);
    expect(active[0].textContent).toMatch(/Schedules/);
  });

  it("routes child clicks via onSelectRuntimeChild, not onSelect", () => {
    const { onSelect, onSelectRuntimeChild } = renderSidebar({ active: "runtime:agents" });
    screen.getByRole("button", { name: /^Sessions$/ }).click();
    expect(onSelectRuntimeChild).toHaveBeenCalledWith("sessions");
    expect(onSelect).not.toHaveBeenCalled();

    onSelect.mockClear();
    onSelectRuntimeChild.mockClear();
    screen.getByRole("button", { name: /^Tasks$/ }).click();
    expect(onSelectRuntimeChild).toHaveBeenCalledWith("tasks");
    expect(onSelect).not.toHaveBeenCalled();

    onSelect.mockClear();
    onSelectRuntimeChild.mockClear();
    screen.getByRole("button", { name: /^Schedules$/ }).click();
    expect(onSelectRuntimeChild).toHaveBeenCalledWith("schedules");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("routes parent (Runtime) clicks via onSelect, not onSelectRuntimeChild", () => {
    const { onSelect, onSelectRuntimeChild } = renderSidebar({ active: "overview" });
    screen.getByRole("button", { name: /^Runtime$/ }).click();
    expect(onSelect).toHaveBeenCalledWith("runtime");
    expect(onSelectRuntimeChild).not.toHaveBeenCalled();
  });

  it("uses a distinct icon for the Agents child vs the Runtime parent (v4 Bug 4)", () => {
    // PR #189 polish v4 Bug 4 — Runtime parent (RuntimeIcon, a stacked
    // chevron + bar glyph) and the Agents child used to share the same
    // SVG, making the two rows visually indistinguishable. The child
    // now uses a user-circle outline so each row reads as its own
    // affordance. Lock that in by comparing the rendered `path[d]`
    // attributes — they must not be the same.
    renderSidebar({ active: "runtime:agents" });

    const runtimeBtn = screen.getByRole("button", { name: /^Runtime$/ });
    const agentsBtn = screen.getByRole("button", { name: /^Agents$/ });
    const runtimePaths = Array.from(runtimeBtn.querySelectorAll("svg path"))
      .map((p) => p.getAttribute("d"))
      .filter(Boolean)
      .join("|");
    const agentsPaths = Array.from(agentsBtn.querySelectorAll("svg path"))
      .map((p) => p.getAttribute("d"))
      .filter(Boolean)
      .join("|");
    expect(runtimePaths).not.toBe("");
    expect(agentsPaths).not.toBe("");
    expect(runtimePaths).not.toBe(agentsPaths);
  });
});
