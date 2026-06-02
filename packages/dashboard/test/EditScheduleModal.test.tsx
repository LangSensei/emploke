import type { AgentEntry } from "@emploke/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleDetail } from "../src/api";

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    previewCron: vi.fn(),
    patchSchedule: vi.fn(),
    getSchedule: vi.fn(),
  };
});

import * as api from "../src/api";
import { EditScheduleModal } from "../src/components/schedules/EditScheduleModal";

const mockPreviewCron = api.previewCron as unknown as ReturnType<typeof vi.fn>;
const mockPatchSchedule = api.patchSchedule as unknown as ReturnType<typeof vi.fn>;
const mockGetSchedule = api.getSchedule as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
}

const SAMPLE: ScheduleDetail = {
  id: "sched-1",
  name: "Daily report",
  enabled: true,
  trigger: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
  target: {
    kind: "task",
    agent: "emploke/dev",
    brief: "Generate the report.",
    details: "Use last 24h of data.",
    runtime: "copilot",
  },
  nextFireAt: "2026-06-01T01:00:00.000Z",
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-20T00:00:00Z",
  describe: "every day at 09:00 Asia/Shanghai",
};

function renderModal(overrides: Partial<React.ComponentProps<typeof EditScheduleModal>> = {}) {
  const onClose = vi.fn();
  const onPatched = vi.fn();
  const utils = render(
    <EditScheduleModal
      open={true}
      schedule={SAMPLE}
      agents={[makeAgent("emploke/dev"), makeAgent("emploke/review")]}
      runtimes={["copilot", "claude"]}
      existingTimezones={["Asia/Shanghai", "UTC"]}
      onClose={onClose}
      onPatched={onPatched}
      {...overrides}
    />,
  );
  return { ...utils, onClose, onPatched };
}

beforeEach(() => {
  mockPreviewCron.mockReset();
  mockPatchSchedule.mockReset();
  mockGetSchedule.mockReset();
  mockPreviewCron.mockResolvedValue({
    describe: "preview describe",
    nextRuns: [
      "2026-06-01T01:00:00.000Z",
      "2026-06-02T01:00:00.000Z",
      "2026-06-03T01:00:00.000Z",
      "2026-06-04T01:00:00.000Z",
      "2026-06-05T01:00:00.000Z",
    ],
  });
  mockPatchSchedule.mockResolvedValue({ ...SAMPLE });
  mockGetSchedule.mockResolvedValue({ ...SAMPLE });
});

afterEach(() => cleanup());

describe("EditScheduleModal", () => {
  it("seeds fields from the schedule prop", () => {
    renderModal();
    expect((screen.getByTestId("edit-schedule-name") as HTMLInputElement).value).toBe(
      "Daily report",
    );
    expect((screen.getByTestId("edit-schedule-agent") as HTMLSelectElement).value).toBe(
      "emploke/dev",
    );
    expect((screen.getByTestId("edit-schedule-runtime") as HTMLSelectElement).value).toBe(
      "copilot",
    );
    expect((screen.getByTestId("edit-schedule-brief") as HTMLInputElement).value).toBe(
      "Generate the report.",
    );
    expect((screen.getByTestId("edit-schedule-details") as HTMLTextAreaElement).value).toBe(
      "Use last 24h of data.",
    );
    expect((screen.getByTestId("edit-schedule-tz") as HTMLSelectElement).value).toBe(
      "Asia/Shanghai",
    );
    expect(screen.getByTestId("edit-schedule-cron-chip").textContent).toBe("0 9 * * *");
  });

  it("Save is disabled when there is no diff", () => {
    renderModal();
    expect((screen.getByTestId("edit-schedule-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Save becomes enabled after editing the name and submits a sparse PATCH body", async () => {
    const { onPatched, onClose } = renderModal();
    fireEvent.change(screen.getByTestId("edit-schedule-name"), {
      target: { value: "Weekly report" },
    });
    const save = await waitFor(() => {
      const btn = screen.getByTestId("edit-schedule-submit") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    fireEvent.click(save);
    await waitFor(() => {
      expect(mockPatchSchedule).toHaveBeenCalledWith("sched-1", { name: "Weekly report" });
    });
    await waitFor(() => {
      expect(mockGetSchedule).toHaveBeenCalledWith("sched-1");
    });
    await waitFor(() => {
      expect(onPatched).toHaveBeenCalled();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("clearing the details field sends target.details: null (RFC 7396 delete)", async () => {
    renderModal();
    fireEvent.change(screen.getByTestId("edit-schedule-details"), { target: { value: "" } });
    const save = await waitFor(() => {
      const btn = screen.getByTestId("edit-schedule-submit") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    fireEvent.click(save);
    await waitFor(() => {
      expect(mockPatchSchedule).toHaveBeenCalledWith("sched-1", {
        target: { details: null },
      });
    });
  });

  it("clearing the runtime sends target.runtime: null", async () => {
    renderModal();
    fireEvent.change(screen.getByTestId("edit-schedule-runtime"), { target: { value: "" } });
    const save = await waitFor(() => {
      const btn = screen.getByTestId("edit-schedule-submit") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    fireEvent.click(save);
    await waitFor(() => {
      expect(mockPatchSchedule).toHaveBeenCalledWith("sched-1", {
        target: { runtime: null },
      });
    });
  });

  it("changing the timezone sends a full trigger replacement", async () => {
    renderModal();
    fireEvent.change(screen.getByTestId("edit-schedule-tz"), { target: { value: "UTC" } });
    const save = await waitFor(() => {
      const btn = screen.getByTestId("edit-schedule-submit") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    fireEvent.click(save);
    await waitFor(() => {
      expect(mockPatchSchedule).toHaveBeenCalledWith("sched-1", {
        trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      });
    });
  });

  it("surfaces server PATCH errors inline and keeps the modal open", async () => {
    mockPatchSchedule.mockRejectedValue(new Error("schedule conflict"));
    const { onClose } = renderModal();
    fireEvent.change(screen.getByTestId("edit-schedule-name"), {
      target: { value: "Weekly report" },
    });
    const save = await waitFor(() => {
      const btn = screen.getByTestId("edit-schedule-submit") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    fireEvent.click(save);
    await waitFor(() => {
      expect(screen.getByTestId("edit-schedule-submit-error").textContent).toMatch(
        /schedule conflict/,
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("surfaces a 'not installed' option when the schedule's agent isn't in the registered list", () => {
    renderModal({ agents: [makeAgent("emploke/review")] });
    const sel = screen.getByTestId("edit-schedule-agent") as HTMLSelectElement;
    const opts = Array.from(sel.options).map((o) => o.textContent);
    expect(opts.some((t) => t?.includes("not installed"))).toBe(true);
  });
});
