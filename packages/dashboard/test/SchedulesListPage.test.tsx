import type { AgentEntry } from "@emploke/catalog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleDetail as ScheduleDetailType, ScheduleView } from "../src/api";

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    listSchedules: vi.fn(),
    getSchedule: vi.fn(),
    previewSchedule: vi.fn(),
    listScheduledTasks: vi.fn(),
    listRuntimes: vi.fn(),
    createSchedule: vi.fn(),
    previewCron: vi.fn(),
  };
});

import * as api from "../src/api";
import { HeaderActionsContext } from "../src/components/HeaderActions";
import { SchedulesPage } from "../src/pages/Schedules";

const mockListSchedules = api.listSchedules as unknown as ReturnType<typeof vi.fn>;
const mockGetSchedule = api.getSchedule as unknown as ReturnType<typeof vi.fn>;
const mockPreviewSchedule = api.previewSchedule as unknown as ReturnType<typeof vi.fn>;
const mockListScheduledTasks = api.listScheduledTasks as unknown as ReturnType<typeof vi.fn>;
const mockListRuntimes = api.listRuntimes as unknown as ReturnType<typeof vi.fn>;
const mockCreateSchedule = api.createSchedule as unknown as ReturnType<typeof vi.fn>;
const mockPreviewCron = api.previewCron as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
}

function makeSchedule(
  partial: Partial<ScheduleView> &
    Pick<ScheduleView, "id" | "name" | "enabled" | "trigger" | "target" | "nextFireAt">,
): ScheduleView {
  return {
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-20T00:00:00Z",
    ...partial,
  };
}

function makeDetail(view: ScheduleView, describe: string): ScheduleDetailType {
  return { ...view, describe };
}

function renderSchedules(initialPath: string, agents: AgentEntry[]) {
  // The "New schedule" button is portalled into the workspace shell's
  // HeaderActions host (issue #222). Provide a host in the test so
  // the CTA surfaces in the rendered DOM instead of returning null.
  const headerHost = document.createElement("div");
  document.body.appendChild(headerHost);
  return render(
    <HeaderActionsContext.Provider value={headerHost}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/workspaces/:wsId/runtime/schedules"
            element={<SchedulesPage agents={agents} currentWorkspaceId="ws-1" />}
          />
        </Routes>
      </MemoryRouter>
    </HeaderActionsContext.Provider>,
  );
}

beforeEach(() => {
  mockListSchedules.mockReset();
  mockGetSchedule.mockReset();
  mockPreviewSchedule.mockReset();
  mockListScheduledTasks.mockReset();
  mockListRuntimes.mockReset();
  mockCreateSchedule.mockReset();
  mockPreviewCron.mockReset();
  mockListSchedules.mockResolvedValue([]);
  mockGetSchedule.mockResolvedValue(undefined);
  mockPreviewSchedule.mockResolvedValue({ describe: "test", nextRuns: [] });
  mockListScheduledTasks.mockResolvedValue([]);
  mockListRuntimes.mockResolvedValue([{ kind: "copilot", capabilities: {} }]);
  mockPreviewCron.mockResolvedValue({ describe: "mock", nextRuns: [] });
  mockCreateSchedule.mockResolvedValue({
    id: "sched-new",
    name: "from-form",
    enabled: true,
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: { kind: "task", agent: "emploke/dev", brief: "do it" },
    nextFireAt: "2026-06-01T09:00:00.000Z",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  });
});

afterEach(() => cleanup());

describe("SchedulesPage list", () => {
  const agents = [makeAgent("emploke/dev"), makeAgent("emploke/review")];

  it("renders one row per schedule sorted by nextFireAt", async () => {
    const rows: ScheduleView[] = [
      makeSchedule({
        id: "sched-a",
        name: "Schedule A",
        enabled: true,
        trigger: { kind: "cron", expr: "0 0 1 * * *", tz: "UTC" },
        target: { kind: "task", agent: "emploke/dev", brief: "do a" },
        nextFireAt: "2026-06-01T01:00:00.000Z",
      }),
      makeSchedule({
        id: "sched-b",
        name: "Schedule B",
        enabled: false,
        trigger: { kind: "cron", expr: "0 0 2 * * *", tz: "UTC" },
        target: { kind: "task", agent: "emploke/review", brief: "do b" },
        nextFireAt: "2026-05-30T02:00:00.000Z",
      }),
    ];
    mockListSchedules.mockResolvedValue(rows);
    // Auto-selection bind will GET the first sorted row (sched-b earlier nextFireAt).
    mockGetSchedule.mockResolvedValue(makeDetail(rows[1]!, "daily at 02:00"));

    renderSchedules("/workspaces/ws-1/runtime/schedules", agents);

    await waitFor(() => {
      expect(screen.getByText("Schedule A")).toBeTruthy();
      expect(screen.getByText("Schedule B")).toBeTruthy();
    });

    // Sorted ascending by nextFireAt: B (May 30) before A (June 1).
    const items = document.querySelectorAll("[data-testid^='schedule-row-']");
    expect(items[0]?.getAttribute("data-testid")).toBe("schedule-row-sched-b");
    expect(items[1]?.getAttribute("data-testid")).toBe("schedule-row-sched-a");
  });

  it("renders an Enabled vs Paused badge per row", async () => {
    const rows: ScheduleView[] = [
      makeSchedule({
        id: "s-on",
        name: "Live",
        enabled: true,
        trigger: { kind: "cron", expr: "*/5 * * * * *", tz: "UTC" },
        target: { kind: "task", agent: "emploke/dev", brief: "x" },
        nextFireAt: "2026-06-01T01:00:00.000Z",
      }),
      makeSchedule({
        id: "s-off",
        name: "Paused one",
        enabled: false,
        trigger: { kind: "cron", expr: "0 0 9 * * 1", tz: "UTC" },
        target: { kind: "task", agent: "emploke/dev", brief: "x" },
        nextFireAt: "2026-06-02T09:00:00.000Z",
      }),
    ];
    mockListSchedules.mockResolvedValue(rows);
    mockGetSchedule.mockResolvedValue(makeDetail(rows[0]!, "every 5 sec"));

    renderSchedules("/workspaces/ws-1/runtime/schedules", agents);

    await waitFor(() => {
      expect(screen.getAllByText(/Enabled/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Paused/).length).toBeGreaterThan(0);
    });
  });

  it("renders the workspace-empty zero state when no schedules and no active filter", async () => {
    mockListSchedules.mockResolvedValue([]);

    renderSchedules("/workspaces/ws-1/runtime/schedules", agents);

    await waitFor(() => {
      expect(screen.getByTestId("schedules-empty-zero")).toBeTruthy();
    });
  });

  it("forwards the agent filter from ?agent= to listSchedules", async () => {
    mockListSchedules.mockResolvedValue([]);

    renderSchedules("/workspaces/ws-1/runtime/schedules?agent=emploke/dev", agents);

    await waitFor(() => {
      expect(mockListSchedules).toHaveBeenCalledWith({ agent: "emploke/dev" });
    });
  });

  it("forwards ?enabled=false as { enabled: false } to listSchedules", async () => {
    mockListSchedules.mockResolvedValue([]);

    renderSchedules("/workspaces/ws-1/runtime/schedules?enabled=false", agents);

    await waitFor(() => {
      expect(mockListSchedules).toHaveBeenCalledWith({ enabled: false });
    });
  });
});

describe("SchedulesPage — New schedule CTA + zero-state copy (issue #222)", () => {
  const agents = [makeAgent("emploke/dev"), makeAgent("emploke/review")];

  // ── Zero-state copy regression: the old "CLI-only in v1" sentence
  // for creation has been replaced with a CTA pointing at the New
  // schedule button. Existing edit-side CLI-only language stays
  // (emploke schedule patch).
  it("zero-state copy reflects the new CTA, not the old CLI-only sentence", async () => {
    mockListSchedules.mockResolvedValue([]);
    renderSchedules("/workspaces/ws-1/runtime/schedules", agents);
    await waitFor(() => expect(screen.getByTestId("schedules-empty-zero")).toBeTruthy());
    expect(screen.getAllByText(/New schedule/i).length).toBeGreaterThan(0);
    // The pre-#222 sentence "Create one from the CLI" must not be there.
    expect(screen.queryByText(/Create one from the CLI/i)).toBeNull();
    // The edit half DOES stay CLI-only — keep the patch language so
    // users know the rule for editing.
    expect(screen.getByText(/emploke schedule patch/)).toBeTruthy();
  });

  // ── The CTA must be present in all four (loaded, empty/filter)
  // combinations so the zero-state copy that says "click the button
  // above" doesn't point at a missing button. Mounting it in
  // HeaderActions (outside both empty branches) is what guarantees
  // this; this test pins the contract.
  it.each([
    {
      name: "loaded-empty + no filters",
      url: "/workspaces/ws-1/runtime/schedules",
      rows: [] as ScheduleView[],
    },
    {
      name: "loaded-empty + agent filter",
      url: "/workspaces/ws-1/runtime/schedules?agent=emploke/dev",
      rows: [] as ScheduleView[],
    },
    {
      name: "rows + agent filter that excludes everything",
      url: "/workspaces/ws-1/runtime/schedules?agent=emploke/review",
      rows: [
        makeSchedule({
          id: "sched-a",
          name: "A",
          enabled: true,
          trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          target: { kind: "task", agent: "emploke/dev", brief: "x" },
          nextFireAt: "2026-06-01T01:00:00.000Z",
        }),
      ],
    },
    {
      name: "rows + no filters",
      url: "/workspaces/ws-1/runtime/schedules",
      rows: [
        makeSchedule({
          id: "sched-a",
          name: "A",
          enabled: true,
          trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          target: { kind: "task", agent: "emploke/dev", brief: "x" },
          nextFireAt: "2026-06-01T01:00:00.000Z",
        }),
      ],
    },
  ])("New schedule button is visible: $name", async ({ url, rows }) => {
    mockListSchedules.mockResolvedValue(rows);
    if (rows.length > 0) {
      mockGetSchedule.mockResolvedValue(makeDetail(rows[0]!, "every day at 09:00"));
    }
    renderSchedules(url, agents);
    const cta = await screen.findByTestId("schedules-new-cta");
    expect(cta).toBeTruthy();
    expect((cta as HTMLButtonElement).textContent).toMatch(/New schedule/i);
  });

  it("clicking the CTA opens the modal", async () => {
    mockListSchedules.mockResolvedValue([]);
    renderSchedules("/workspaces/ws-1/runtime/schedules", agents);
    const cta = await screen.findByTestId("schedules-new-cta");
    fireEvent.click(cta);
    await waitFor(() => expect(screen.getByTestId("create-schedule-form")).toBeTruthy());
  });

  it("filling the form + submitting calls createSchedule with the typed body", async () => {
    mockListSchedules.mockResolvedValue([]);
    renderSchedules("/workspaces/ws-1/runtime/schedules", agents);
    fireEvent.click(await screen.findByTestId("schedules-new-cta"));
    await waitFor(() => expect(screen.getByTestId("create-schedule-form")).toBeTruthy());
    fireEvent.change(screen.getByTestId("create-schedule-name"), { target: { value: "A" } });
    fireEvent.change(screen.getByTestId("create-schedule-brief"), {
      target: { value: "do it" },
    });
    // Wait past the 300ms debounce so the submit button enables.
    await new Promise((r) => setTimeout(r, 350));
    const submit = screen.getByTestId("create-schedule-submit") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
    const body = mockCreateSchedule.mock.calls[0]![0];
    expect(body.name).toBe("A");
    expect(body.target.agent).toBe("emploke/dev");
    expect(body.trigger).toEqual({ kind: "cron", expr: "0 9 * * *", tz: expect.any(String) });
  });

  // ── Create-while-filtered: if the active filters would hide the
  // freshly-created row, Schedules.tsx resets the filters so the
  // new row appears in the list. Pin that contract.
  it("create-while-filtered resets the agent filter when the new row would be hidden", async () => {
    mockListSchedules.mockResolvedValue([]);
    // Open with a filter that excludes the new agent.
    renderSchedules("/workspaces/ws-1/runtime/schedules?agent=emploke/review", agents);
    fireEvent.click(await screen.findByTestId("schedules-new-cta"));
    await waitFor(() => expect(screen.getByTestId("create-schedule-form")).toBeTruthy());
    // Select the agent that's not the current filter.
    fireEvent.change(screen.getByTestId("create-schedule-agent"), {
      target: { value: "emploke/dev" },
    });
    fireEvent.change(screen.getByTestId("create-schedule-name"), { target: { value: "A" } });
    fireEvent.change(screen.getByTestId("create-schedule-brief"), {
      target: { value: "do it" },
    });
    await new Promise((r) => setTimeout(r, 350));
    const submit = screen.getByTestId("create-schedule-submit") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    // Returned row matches the picked agent — handleCreated MUST
    // reset the filter so the new row is visible.
    mockCreateSchedule.mockResolvedValueOnce({
      id: "sched-new",
      name: "A",
      enabled: true,
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      target: { kind: "task", agent: "emploke/dev", brief: "do it" },
      nextFireAt: "2026-06-01T09:00:00.000Z",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
    });
    mockGetSchedule.mockResolvedValueOnce({
      id: "sched-new",
      name: "A",
      enabled: true,
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      target: { kind: "task", agent: "emploke/dev", brief: "do it" },
      nextFireAt: "2026-06-01T09:00:00.000Z",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
      describe: "every day at 09:00",
    });
    fireEvent.click(submit);
    // After submit, the page state should have agentFilter reset (so
    // listSchedules is called with `{}`). We assert by waiting for the
    // listSchedules call without the agent option.
    await waitFor(() => {
      const calls = mockListSchedules.mock.calls;
      const resetCallExists = calls.some(
        (call) => call[0] !== undefined && Object.keys(call[0] ?? {}).length === 0,
      );
      expect(resetCallExists).toBe(true);
    });
  });
});
