import type { AgentEntry } from "@emploke/catalog";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  };
});

import * as api from "../src/api";
import { SchedulesPage } from "../src/pages/Schedules";

const mockListSchedules = api.listSchedules as unknown as ReturnType<typeof vi.fn>;
const mockGetSchedule = api.getSchedule as unknown as ReturnType<typeof vi.fn>;
const mockPreviewSchedule = api.previewSchedule as unknown as ReturnType<typeof vi.fn>;
const mockListScheduledTasks = api.listScheduledTasks as unknown as ReturnType<typeof vi.fn>;

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
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/workspaces/:wsId/runtime/schedules"
          element={<SchedulesPage agents={agents} currentWorkspaceId="ws-1" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockListSchedules.mockReset();
  mockGetSchedule.mockReset();
  mockPreviewSchedule.mockReset();
  mockListScheduledTasks.mockReset();
  mockListSchedules.mockResolvedValue([]);
  mockGetSchedule.mockResolvedValue(undefined);
  mockPreviewSchedule.mockResolvedValue({ describe: "test", nextRuns: [] });
  mockListScheduledTasks.mockResolvedValue([]);
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
        target: { kind: "task", agent: "emploke/dev", instructions: "do a" },
        nextFireAt: "2026-06-01T01:00:00.000Z",
      }),
      makeSchedule({
        id: "sched-b",
        name: "Schedule B",
        enabled: false,
        trigger: { kind: "cron", expr: "0 0 2 * * *", tz: "UTC" },
        target: { kind: "task", agent: "emploke/review", instructions: "do b" },
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
        target: { kind: "task", agent: "emploke/dev", instructions: "x" },
        nextFireAt: "2026-06-01T01:00:00.000Z",
      }),
      makeSchedule({
        id: "s-off",
        name: "Paused one",
        enabled: false,
        trigger: { kind: "cron", expr: "0 0 9 * * 1", tz: "UTC" },
        target: { kind: "task", agent: "emploke/dev", instructions: "x" },
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
