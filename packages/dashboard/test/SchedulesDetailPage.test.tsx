import type { AgentEntry } from "@emploke/contracts";
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
    patchSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    runSchedule: vi.fn(),
    listScheduledTasks: vi.fn(),
  };
});

import * as api from "../src/api";
import { SchedulesPage } from "../src/pages/Schedules";

const mockListSchedules = api.listSchedules as unknown as ReturnType<typeof vi.fn>;
const mockGetSchedule = api.getSchedule as unknown as ReturnType<typeof vi.fn>;
const mockPreviewSchedule = api.previewSchedule as unknown as ReturnType<typeof vi.fn>;
const mockPatchSchedule = api.patchSchedule as unknown as ReturnType<typeof vi.fn>;
const mockDeleteSchedule = api.deleteSchedule as unknown as ReturnType<typeof vi.fn>;
const mockRunSchedule = api.runSchedule as unknown as ReturnType<typeof vi.fn>;
const mockListScheduledTasks = api.listScheduledTasks as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
}

const SAMPLE_VIEW: ScheduleView = {
  id: "sched-x",
  name: "Sample schedule",
  enabled: true,
  trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
  target: {
    kind: "task",
    agent: "emploke/dev",
    brief: "Do the thing.",
    runtime: "copilot",
  },
  nextFireAt: "2026-05-30T09:00:00.000Z",
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-20T00:00:00Z",
};

const SAMPLE_DETAIL: ScheduleDetailType = { ...SAMPLE_VIEW, describe: "every day at 09:00" };

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/workspaces/ws-1/runtime/schedules?scheduleId=sched-x"]}>
      <Routes>
        <Route
          path="/workspaces/:wsId/runtime/schedules"
          element={<SchedulesPage agents={[makeAgent("emploke/dev")]} currentWorkspaceId="ws-1" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockListSchedules.mockReset();
  mockGetSchedule.mockReset();
  mockPreviewSchedule.mockReset();
  mockPatchSchedule.mockReset();
  mockDeleteSchedule.mockReset();
  mockRunSchedule.mockReset();
  mockListScheduledTasks.mockReset();
  mockListSchedules.mockResolvedValue([SAMPLE_VIEW]);
  mockGetSchedule.mockResolvedValue(SAMPLE_DETAIL);
  mockPreviewSchedule.mockResolvedValue({
    describe: SAMPLE_DETAIL.describe,
    nextRuns: ["2026-05-30T09:00:00.000Z", "2026-05-31T09:00:00.000Z", "2026-06-01T09:00:00.000Z"],
  });
  mockListScheduledTasks.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe("Schedule detail panel", () => {
  it("renders the name, cron expression, tz, and describe", async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Sample schedule" })).toBeTruthy();
    });
    // The cron expression also appears in the list row on the left; the
    // detail header includes it at least once.
    expect(screen.getAllByText("0 9 * * *").length).toBeGreaterThan(0);
    expect(screen.getByText("UTC")).toBeTruthy();
    expect(screen.getByText(/every day at 09:00/)).toBeTruthy();
  });

  it("renders the next-fire header fact (single line) and previews n=1", async () => {
    renderDetail();
    // The next-fire fact lives in the header right column as a "Next fire X" line.
    const nextFireLine = await screen.findByTestId("schedule-detail-next-fire");
    expect(nextFireLine.textContent).toMatch(/Next fire/);
    // Preview only needs the very next run now that the body's "Next N fires"
    // section was removed — surfacing more than one would be wasted output.
    expect(mockPreviewSchedule).toHaveBeenCalledWith("sched-x", { n: 1 });
  });

  it("patches enabled=false when the Pause button is clicked", async () => {
    mockPatchSchedule.mockResolvedValue({ ...SAMPLE_VIEW, enabled: false });
    renderDetail();
    const toggle = await screen.findByTestId("schedule-detail-toggle");
    expect(toggle.textContent).toMatch(/Pause/);
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(mockPatchSchedule).toHaveBeenCalledWith("sched-x", { enabled: false });
    });
  });

  it("rolls back the optimistic toggle on patch failure", async () => {
    mockPatchSchedule.mockRejectedValue(new Error("server angry"));
    renderDetail();
    const toggle = await screen.findByTestId("schedule-detail-toggle");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByText(/server angry/)).toBeTruthy();
    });
    // After rollback the toggle label is "Pause" again (enabled=true restored).
    expect((await screen.findByTestId("schedule-detail-toggle")).textContent).toMatch(/Pause/);
  });

  it("renders the recent-fires panel with status / clock / duration / id", async () => {
    mockListScheduledTasks.mockResolvedValue([
      {
        id: "task-1",
        agent: "emploke/dev",
        brief: "fire 1",
        origin: "schedule",
        status: "succeeded",
        metadata: { scheduleId: "sched-x" },
        createdAt: "2026-05-28T09:00:00Z",
        startedAt: "2026-05-28T09:00:01Z",
        endedAt: "2026-05-28T09:01:00Z",
      },
    ]);
    renderDetail();
    await waitFor(() => {
      expect(screen.getByText(/Recent fires/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("task-1")).toBeTruthy();
    });
    // Dense row layout adds two new facts beyond the id: a status
    // badge and a wall-clock duration. The duration column reads
    // the difference between startedAt and endedAt — 59 seconds for
    // this fixture, formatted by `formatDuration` as "59s".
    expect(screen.getByText("59s")).toBeTruthy();
    // Status badge label comes from STATUS_LABEL.succeeded.
    expect(screen.getAllByText(/Succeeded/i).length).toBeGreaterThan(0);
  });

  it("calls runSchedule and surfaces errors when Run now is clicked", async () => {
    mockRunSchedule.mockRejectedValue(new Error("dispatch blew up"));
    renderDetail();
    const runBtn = await screen.findByTestId("schedule-detail-run-now");
    fireEvent.click(runBtn);
    await waitFor(() => {
      expect(mockRunSchedule).toHaveBeenCalledWith("sched-x");
    });
    await waitFor(() => {
      expect(screen.getByText(/dispatch blew up/)).toBeTruthy();
    });
  });

  it("stays on the schedule page after a successful Run now and refreshes Recent fires", async () => {
    mockRunSchedule.mockResolvedValue({ dispatchId: "sched-x-run-1" });
    // Prime listScheduledTasks: first call returns empty, second returns the new fire.
    mockListScheduledTasks.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "sched-x-run-1",
        agent: "emploke/dev",
        brief: "Sample schedule (manual run)",
        origin: "schedule",
        status: "running",
        metadata: { scheduleId: "sched-x" },
        createdAt: "2026-05-28T09:05:00Z",
        startedAt: "2026-05-28T09:05:01Z",
      },
    ]);
    renderDetail();
    // Wait for initial mount + initial fires fetch (empty list shown).
    await screen.findByText(/Recent fires/);
    // Click Run now.
    fireEvent.click(await screen.findByTestId("schedule-detail-run-now"));
    // runSchedule was called.
    await waitFor(() => expect(mockRunSchedule).toHaveBeenCalledWith("sched-x"));
    // Recent fires got a refresh fetch (parent bumped refreshToken).
    await waitFor(() => expect(mockListScheduledTasks).toHaveBeenCalledTimes(2));
    // The new fire row eventually surfaces.
    await waitFor(() => expect(screen.getByText("sched-x-run-1")).toBeTruthy());
    // CRUCIALLY: we did NOT leave the schedule page. The "Tasks page
    // stub" route was removed, so any errant redirect would crash
    // the test with "No routes matched". Additionally, the schedule
    // detail Run-now button is still in the DOM.
    expect(screen.getByTestId("schedule-detail-run-now")).toBeTruthy();
  });

  it("opens the delete confirm modal when Delete is clicked", async () => {
    renderDetail();
    const deleteBtn = await screen.findByTestId("schedule-detail-delete");
    fireEvent.click(deleteBtn);
    // The modal renders inside the page-level host. The modal's dialog
    // role + title is the cleanest anchor since the body copy is split
    // across multiple text nodes.
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /^Delete schedule$/ })).toBeTruthy();
  });

  it("calls deleteSchedule when the delete modal is confirmed", async () => {
    mockDeleteSchedule.mockResolvedValue({ deletedDispatchCount: 0 });
    renderDetail();
    const deleteBtn = await screen.findByTestId("schedule-detail-delete");
    fireEvent.click(deleteBtn);
    const confirm = await screen.findByRole("button", { name: /Delete schedule/i });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(mockDeleteSchedule).toHaveBeenCalledWith("sched-x");
    });
  });

  it("shows a transient cascade-count notice after delete (count > 0)", async () => {
    mockDeleteSchedule.mockResolvedValue({ deletedDispatchCount: 3 });
    renderDetail();
    fireEvent.click(await screen.findByTestId("schedule-detail-delete"));
    fireEvent.click(await screen.findByRole("button", { name: /^Delete schedule$/ }));
    const notice = await screen.findByTestId("schedules-delete-notice");
    expect(notice.textContent).toMatch(/Sample schedule/);
    expect(notice.textContent).toMatch(/3 historical dispatch runs also removed/);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("aria-live")).toBe("polite");
  });

  it("singularises the cascade-count notice when exactly one dispatch was removed", async () => {
    mockDeleteSchedule.mockResolvedValue({ deletedDispatchCount: 1 });
    renderDetail();
    fireEvent.click(await screen.findByTestId("schedule-detail-delete"));
    fireEvent.click(await screen.findByRole("button", { name: /^Delete schedule$/ }));
    const notice = await screen.findByTestId("schedules-delete-notice");
    expect(notice.textContent).toMatch(/1 historical dispatch run also removed/);
  });

  it("omits the cascade-count suffix when no dispatches were removed", async () => {
    mockDeleteSchedule.mockResolvedValue({ deletedDispatchCount: 0 });
    renderDetail();
    fireEvent.click(await screen.findByTestId("schedule-detail-delete"));
    fireEvent.click(await screen.findByRole("button", { name: /^Delete schedule$/ }));
    const notice = await screen.findByTestId("schedules-delete-notice");
    expect(notice.textContent).toMatch(/Sample schedule.*deleted\.?$/);
    expect(notice.textContent).not.toMatch(/historical/);
  });

  it("surfaces a 'Last fired never' header line when lastFiredAt is null", async () => {
    // Sanity: the default SAMPLE_DETAIL above has no lastFiredAt set.
    renderDetail();
    const line = await screen.findByTestId("schedule-detail-last-fired");
    expect(line.textContent).toMatch(/Last fired/);
    expect(line.textContent).toMatch(/never/);
  });

  it("surfaces a 'Last fired …' header line when lastFiredAt is set", async () => {
    mockGetSchedule.mockResolvedValue({
      ...SAMPLE_DETAIL,
      lastFiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    renderDetail();
    const line = await screen.findByTestId("schedule-detail-last-fired");
    expect(line.textContent).toMatch(/Last fired/);
    // formatRelative emits "1h ago" / "2h ago" — accept either to keep
    // the test resilient to rounding at the 5-second boundary.
    expect(line.textContent).toMatch(/h ago|m ago/);
  });

  it("opens the EditScheduleModal when the Edit button is clicked", async () => {
    renderDetail();
    const editBtn = await screen.findByTestId("schedule-detail-edit");
    fireEvent.click(editBtn);
    expect(await screen.findByTestId("edit-schedule-form")).toBeTruthy();
    expect((screen.getByTestId("edit-schedule-name") as HTMLInputElement).value).toBe(
      "Sample schedule",
    );
  });

  it("swaps to Mode B (fire-task detail pane) when a recent fire row is clicked", async () => {
    mockListScheduledTasks.mockResolvedValue([
      {
        id: "task-1",
        agent: "emploke/dev",
        brief: "fire 1",
        origin: "schedule",
        status: "succeeded",
        metadata: { scheduleId: "sched-x" },
        createdAt: "2026-05-28T09:00:00Z",
        startedAt: "2026-05-28T09:00:01Z",
        endedAt: "2026-05-28T09:01:00Z",
      },
    ]);
    renderDetail();
    const fireRow = await screen.findByTestId("schedule-fire-row-task-1");
    fireEvent.click(fireRow);
    expect(await screen.findByTestId("fire-task-nav")).toBeTruthy();
    expect(screen.getByTestId("fire-task-back")).toBeTruthy();
  });
});
