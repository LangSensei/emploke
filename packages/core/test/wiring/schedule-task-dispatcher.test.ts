/**
 * Unit tests for `makeScheduleTaskDispatcher`. Post-RFC #61 v2 the
 * adapter is a pass-through between `@emploke/schedule`'s
 * `TaskDispatcher` interface and `@emploke/task`'s
 * `TaskService.dispatch`. It still owns:
 *
 *   - structural decoupling (schedule pkg never imports task pkg)
 *   - conditional-spread of optional `details` / `runtime` (NEVER
 *     passes `{ details: undefined }` / `{ runtime: undefined }`
 *     under exactOptionalPropertyTypes)
 *   - return-shape narrowing to `{ id }` (rest of TaskEntity is not
 *     leaked through the schedule pkg's narrower contract)
 *   - hasInFlightForSchedule pass-through
 */

import type { TaskService } from "@emploke/task";
import { describe, expect, it, vi } from "vitest";
import { makeScheduleTaskDispatcher } from "../../src/wiring/schedule-task-dispatcher.js";

function stubTaskService(dispatchReturn: { id: string } = { id: "task-xyz" }): {
  dispatch: ReturnType<typeof vi.fn>;
  hasInFlightForSchedule: ReturnType<typeof vi.fn>;
  service: TaskService;
} {
  const dispatch = vi.fn(async () => dispatchReturn);
  const hasInFlightForSchedule = vi.fn(async () => false);
  const service = { dispatch, hasInFlightForSchedule } as unknown as TaskService;
  return { dispatch, hasInFlightForSchedule, service };
}

describe("makeScheduleTaskDispatcher", () => {
  it("passes agent, brief, origin, metadata straight through", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      brief: "Summarize yesterday",
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.agent).toBe("writer");
    expect(call.brief).toBe("Summarize yesterday");
    expect(call.origin).toBe("schedule");
    expect(call.metadata).toEqual({ scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" });
  });

  it("forwards details verbatim when provided", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      brief: "Daily summary",
      details: "Long markdown body here.\n- a\n- b",
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.brief).toBe("Daily summary");
    expect(call.details).toBe("Long markdown body here.\n- a\n- b");
  });

  it("OMITS details from the underlying dispatch call when not provided", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      brief: "Body",
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    // Critical: `{ details: undefined }` is NOT equivalent to omitting
    // the key under exactOptionalPropertyTypes. The adapter uses the
    // conditional-spread pattern `...(details !== undefined ? { details } : {})`
    // to satisfy that constraint.
    expect(Object.hasOwn(call, "details")).toBe(false);
  });

  it("forwards details when set to an empty string (mirrors @emploke/task lax shape)", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      brief: "Body",
      details: "",
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(call, "details")).toBe(true);
    expect(call.details).toBe("");
  });

  it("OMITS runtime from the underlying dispatch call when not provided", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      brief: "Body",
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(call, "runtime")).toBe(false);
  });

  it("forwards runtime when provided", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      brief: "Body",
      runtime: "copilot",
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.runtime).toBe("copilot");
  });

  it("returns just { id } from the dispatch (not the full TaskEntity)", async () => {
    // Simulate a TaskEntity-shaped object; the adapter should expose
    // ONLY id to the schedule pkg per its TaskDispatcher contract.
    const fakeEntity = {
      id: "task-001",
      agent: "writer",
      brief: "...",
      status: "running",
      metadata: { workdir: "/secret/dir", pid: 12345 },
    };
    const { service } = stubTaskService(fakeEntity as unknown as { id: string });
    const adapter = makeScheduleTaskDispatcher(service);
    const out = await adapter.dispatch({
      agent: "writer",
      brief: "x",
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    expect(out).toEqual({ id: "task-001" });
    expect(Object.keys(out)).toEqual(["id"]);
  });

  it("hasInFlightForSchedule passes through (one stub call, one arg)", async () => {
    const { hasInFlightForSchedule, service } = stubTaskService();
    hasInFlightForSchedule.mockResolvedValue(true);
    const adapter = makeScheduleTaskDispatcher(service);
    const out = await adapter.hasInFlightForSchedule("sched-abc");
    expect(out).toBe(true);
    expect(hasInFlightForSchedule).toHaveBeenCalledTimes(1);
    expect(hasInFlightForSchedule).toHaveBeenCalledWith("sched-abc");
  });
});
