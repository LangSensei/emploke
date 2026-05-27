/**
 * Unit tests for `makeScheduleTaskDispatcher`. Verifies the shape
 * adaptation between `@emploke/schedule`'s `TaskDispatcher` interface
 * and `@emploke/task`'s `TaskService.dispatch` — specifically:
 *
 *   - passthrough of agent / details / origin / metadata
 *   - first-line truncation + ellipsis for brief
 *   - fallback to `Scheduled run <scheduleId>` on empty instructions
 *   - conditional spread of optional runtime (NEVER passes
 *     `{ runtime: undefined }` per exactOptionalPropertyTypes)
 *   - return shape collapses to `{ id }` (rest of TaskEntity is not
 *     leaked through the schedule pkg's narrower contract)
 *   - hasInFlightForSchedule is a pass-through (one call, one arg)
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
  it("passes agent, details, origin, metadata straight through", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      instructions: "Summarize yesterday",
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.agent).toBe("writer");
    expect(call.details).toBe("Summarize yesterday");
    expect(call.origin).toBe("schedule");
    expect(call.metadata).toEqual({ scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" });
  });

  it("uses the first line of instructions as brief", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      instructions: "Daily summary\n\nLong markdown body here.\n- a\n- b",
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.brief).toBe("Daily summary");
    expect(typeof call.brief).toBe("string");
    expect((call.brief as string).includes("\n")).toBe(false);
  });

  it("truncates briefs > 200 chars with an ellipsis (length stays ≤ 200)", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    const longLine = "x".repeat(500);
    await adapter.dispatch({
      agent: "writer",
      instructions: longLine,
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    const brief = call.brief as string;
    expect(brief.length).toBe(200);
    expect(brief.endsWith("...")).toBe(true);
    // The original instructions are preserved verbatim in details.
    expect(call.details).toBe(longLine);
  });

  it("falls back to `Scheduled run <scheduleId>` when instructions is empty", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      instructions: "",
      origin: "schedule",
      metadata: { scheduleId: "sched-abc", firedAt: "2026-06-01T00:00:00Z" },
    });
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.brief).toBe("Scheduled run sched-abc");
  });

  it("falls back when instructions is whitespace / newline only", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      instructions: "   \n  \n",
      origin: "schedule",
      metadata: { scheduleId: "s-2", firedAt: "2026-06-01T00:00:00Z" },
    });
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.brief).toBe("Scheduled run s-2");
  });

  it("OMITS runtime from the underlying dispatch call when not provided", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      instructions: "Body",
      origin: "schedule",
      metadata: { scheduleId: "s-1", firedAt: "2026-06-01T00:00:00Z" },
    });
    const call = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    // Critical: `{ runtime: undefined }` is NOT equivalent to omitting
    // the key under exactOptionalPropertyTypes. The adapter uses the
    // conditional-spread pattern `...(runtime !== undefined ? { runtime } : {})`
    // to satisfy that constraint.
    expect(Object.hasOwn(call, "runtime")).toBe(false);
  });

  it("forwards runtime when provided", async () => {
    const { dispatch, service } = stubTaskService();
    const adapter = makeScheduleTaskDispatcher(service);
    await adapter.dispatch({
      agent: "writer",
      instructions: "Body",
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
      instructions: "x",
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
