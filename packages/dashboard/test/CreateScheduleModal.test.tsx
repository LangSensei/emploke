import type { AgentEntry } from "@emploke/catalog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleView } from "../src/api";

// Mock the API module so the modal hits in-test mocks for both
// `previewCron` (debounced live preview) and `createSchedule`
// (submit). The default `vi.mock` factory restores every other
// export so the rest of the dashboard surface still imports cleanly.
vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    previewCron: vi.fn(),
    createSchedule: vi.fn(),
  };
});

import * as api from "../src/api";
import { CreateScheduleModal } from "../src/components/schedules/CreateScheduleModal";

const mockPreviewCron = api.previewCron as unknown as ReturnType<typeof vi.fn>;
const mockCreateSchedule = api.createSchedule as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
}

const SAMPLE_CREATED: ScheduleView = {
  id: "sched-new",
  name: "from-test",
  enabled: true,
  trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
  target: { kind: "task", agent: "emploke/dev", instructions: "do it" },
  nextFireAt: "2026-06-01T09:00:00.000Z",
  createdAt: "2026-05-28T00:00:00.000Z",
  updatedAt: "2026-05-28T00:00:00.000Z",
};

function renderModal(overrides: Partial<React.ComponentProps<typeof CreateScheduleModal>> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const utils = render(
    <CreateScheduleModal
      open={true}
      agents={[makeAgent("emploke/dev"), makeAgent("emploke/review")]}
      runtimes={["copilot", "claude"]}
      existingTimezones={["Asia/Shanghai", "Europe/Berlin"]}
      onClose={onClose}
      onCreated={onCreated}
      {...overrides}
    />,
  );
  return { ...utils, onClose, onCreated };
}

beforeEach(() => {
  mockPreviewCron.mockReset();
  mockCreateSchedule.mockReset();
  mockPreviewCron.mockResolvedValue({
    describe: "mock describe",
    nextRuns: [
      "2026-06-01T09:00:00.000Z",
      "2026-06-02T09:00:00.000Z",
      "2026-06-03T09:00:00.000Z",
      "2026-06-04T09:00:00.000Z",
      "2026-06-05T09:00:00.000Z",
    ],
  });
  mockCreateSchedule.mockResolvedValue(SAMPLE_CREATED);
});

afterEach(() => cleanup());

async function flushDebounce() {
  // Real timers: just sleep past the 300ms debounce + a slack window
  // for the resolved promise's microtask chain to drain.
  await new Promise((resolve) => setTimeout(resolve, 350));
}

describe("CreateScheduleModal", () => {
  it("renders with name and instructions empty → submit disabled", async () => {
    renderModal();
    const submit = screen.getByTestId("create-schedule-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("default 'Daily at 09:00' preset produces cron 0 9 * * * in the chip", async () => {
    renderModal();
    const chip = screen.getByTestId("create-schedule-cron-chip");
    expect(chip.textContent).toBe("0 9 * * *");
  });

  it("debounces preview by 300ms, then renders describe + 5 nextRuns", async () => {
    renderModal();
    // Initial render kicks off a preview after 300ms debounce.
    expect(mockPreviewCron).not.toHaveBeenCalled();
    await flushDebounce();
    // After the debounce, the fetch fires with the daily preset cron.
    // Second arg is the AbortController.signal the modal uses to
    // cancel in-flight requests when a newer one supersedes them.
    expect(mockPreviewCron).toHaveBeenCalledTimes(1);
    expect(mockPreviewCron).toHaveBeenCalledWith(
      {
        expr: "0 9 * * *",
        tz: expect.any(String),
        n: 5,
      },
      expect.any(AbortSignal),
    );
    await waitFor(() => {
      expect(screen.getByTestId("create-schedule-preview-describe").textContent).toBe(
        "mock describe",
      );
    });
    const items = screen.getByTestId("create-schedule-preview-next").querySelectorAll("li");
    expect(items.length).toBe(5);
  });

  it("Advanced mode: typed cron expr is what previewCron and createSchedule see (no preset re-emit)", async () => {
    const { onCreated, onClose } = renderModal();
    // Switch preset → advanced.
    fireEvent.change(screen.getByTestId("create-schedule-preset"), {
      target: { value: "advanced" },
    });
    const advancedInput = screen.getByTestId("create-schedule-advanced") as HTMLInputElement;
    fireEvent.change(advancedInput, { target: { value: "  */5 9-17 * * 1-5  " } });
    fireEvent.change(screen.getByTestId("create-schedule-name"), {
      target: { value: "five-min" },
    });
    fireEvent.change(screen.getByTestId("create-schedule-instructions"), {
      target: { value: "do it" },
    });
    await flushDebounce();
    // The preview MUST have been called with the trimmed expr.
    expect(mockPreviewCron).toHaveBeenCalledWith(
      expect.objectContaining({ expr: "*/5 9-17 * * 1-5" }),
      expect.any(AbortSignal),
    );
    const submit = screen.getByTestId("create-schedule-submit") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
    const body = mockCreateSchedule.mock.calls[0]![0];
    expect(body.trigger.expr).toBe("*/5 9-17 * * 1-5");
    expect(body.target.agent).toBe("emploke/dev");
    expect(body.name).toBe("five-min");
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(SAMPLE_CREATED));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("server 400 on submit: modal stays open, error rendered inline (server's verbatim message)", async () => {
    const { onCreated, onClose } = renderModal();
    fireEvent.change(screen.getByTestId("create-schedule-name"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("create-schedule-instructions"), {
      target: { value: "y" },
    });
    await flushDebounce();
    // Server-error path: extractError preserves the body's `error`
    // field, so the thrown Error.message is the verbatim server
    // string. The "schedule preview: 400" generic form is a
    // regression of the extractError contract.
    mockCreateSchedule.mockRejectedValueOnce(new Error("Invalid cron expression: not a cron"));
    const submit = screen.getByTestId("create-schedule-submit") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    const err = await screen.findByTestId("create-schedule-submit-error");
    expect(err.textContent).toMatch(/Invalid cron expression: not a cron/);
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(submit.disabled).toBe(false);
  });

  it("preview-side server error surfaces inline as the preview error (not the chip)", async () => {
    mockPreviewCron.mockReset();
    mockPreviewCron.mockRejectedValue(new Error("Unknown timezone: Mars/Olympus"));
    renderModal({ existingTimezones: ["Mars/Olympus"] });
    fireEvent.change(screen.getByTestId("create-schedule-tz"), {
      target: { value: "Mars/Olympus" },
    });
    const err = await screen.findByTestId("create-schedule-preview-error", undefined, {
      timeout: 1000,
    });
    expect(err.textContent).toMatch(/Unknown timezone: Mars\/Olympus/);
  });
});
