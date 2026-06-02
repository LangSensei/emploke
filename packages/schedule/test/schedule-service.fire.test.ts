import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateScheduleArgs } from "../src/types.js";
import {
  fixedRandomUUID,
  makeScheduleTestHandle,
  type ScheduleTestHandle,
  VALID_UUIDS,
} from "./_helpers.js";

function baseArgs(over: Partial<CreateScheduleArgs> = {}): CreateScheduleArgs {
  return {
    name: "daily-report",
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: { kind: "task", data: { agent: "report-bot", brief: "Run the daily report" } },
    ...over,
  };
}

describe("ScheduleService.run + private fire flow", () => {
  let h: ScheduleTestHandle;

  beforeEach(() => {
    vi.useFakeTimers();
    h = makeScheduleTestHandle({
      initialNow: new Date("2026-05-01T08:59:00.000Z"),
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
  });

  afterEach(async () => {
    await h.service.shutdown();
    h.close();
    vi.useRealTimers();
  });

  it("run() routes through handler.dispatch with { scheduleId, firedAt, data: <validated payload> }", async () => {
    await h.service.create(baseArgs());
    h.setNow(new Date("2026-05-01T09:00:00.000Z"));
    const { dispatchId } = await h.service.run(VALID_UUIDS[0]!);
    // Default stub dispatch returns dispatch-N sequentially. The
    // service exposes the handler's `id` as `dispatchId`.
    expect(dispatchId).toBe("dispatch-1");
    expect(h.taskHandler.dispatchCalls).toHaveLength(1);
    const call = h.taskHandler.dispatchCalls[0]!;
    expect(call.scheduleId).toBe(VALID_UUIDS[0]);
    expect(call.firedAt).toBe("2026-05-01T09:00:00.000Z");
    // The dispatch receives the validated `data` payload, NOT the
    // full envelope (substrate-handler contract).
    expect(call.data).toEqual({ agent: "report-bot", brief: "Run the daily report" });
  });

  it("run() always allowed even when disabled (bypasses enabled gate)", async () => {
    await h.service.create(baseArgs({ enabled: false }));
    await h.service.run(VALID_UUIDS[0]!);
    expect(h.taskHandler.dispatchCalls).toHaveLength(1);
  });

  it("run() updates lastFiredAt + nextFireAt", async () => {
    await h.service.create(baseArgs());
    h.setNow(new Date("2026-05-01T09:00:00.000Z"));
    await h.service.run(VALID_UUIDS[0]!);
    const after = await h.service.get(VALID_UUIDS[0]!);
    expect(after?.lastFiredAt).toBe("2026-05-01T09:00:00.000Z");
    expect(after?.nextFireAt).toBe("2026-05-02T09:00:00.000Z");
  });

  it("automated fire skips and warns when handler.hasInFlightForSchedule reports true", async () => {
    // create then directly invoke the fire path by reading + asserting
    // that the timer-driven side-effect respects the concurrency rule.
    await h.service.create(baseArgs());
    h.taskHandler.inFlightSet.add(VALID_UUIDS[0]!);
    h.setNow(new Date("2026-05-01T09:00:00.500Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.taskHandler.dispatchCalls).toHaveLength(0);
    // recordFired must NOT have been invoked (no lastFiredAt write
    // on a skip).
    const after = await h.service.get(VALID_UUIDS[0]!);
    expect(after?.lastFiredAt).toBeUndefined();
  });

  it("automated fire dispatches when no in-flight; records fire + re-arms", async () => {
    await h.service.create(baseArgs());
    h.setNow(new Date("2026-05-01T09:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(h.taskHandler.dispatchCalls).toHaveLength(1);
    expect(h.taskHandler.dispatchCalls[0]?.scheduleId).toBe(VALID_UUIDS[0]);
    const after = await h.service.get(VALID_UUIDS[0]!);
    expect(after?.lastFiredAt).toBe("2026-05-01T09:00:00.000Z");
    expect(after?.nextFireAt).toBe("2026-05-02T09:00:00.000Z");
  });
});
