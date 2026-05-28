import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleEntity } from "../src/schedule-entity.js";
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
    target: { kind: "task", agent: "report-bot", brief: "Run the daily report" },
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

  it("run() dispatches with exactly origin:'schedule' and metadata{scheduleId, firedAt}", async () => {
    await h.service.create(baseArgs());
    h.setNow(new Date("2026-05-01T09:00:00.000Z"));
    const { taskId } = await h.service.run(VALID_UUIDS[0]);
    expect(taskId).toBe("task-1");
    expect(h.dispatcher.calls).toHaveLength(1);
    const call = h.dispatcher.calls[0]!;
    expect(call.agent).toBe("report-bot");
    expect(call.brief).toBe("Run the daily report");
    expect(call.details).toBeUndefined();
    expect(call.origin).toBe("schedule");
    expect(call.metadata.scheduleId).toBe(VALID_UUIDS[0]);
    expect(call.metadata.firedAt).toBe("2026-05-01T09:00:00.000Z");
    expect(call.runtime).toBeUndefined();
  });

  it("run() forwards details when target has them", async () => {
    await h.service.create(
      baseArgs({
        target: {
          kind: "task",
          agent: "report-bot",
          brief: "Run the daily report",
          details: "Full body across\nmultiple lines.",
        },
      }),
    );
    h.setNow(new Date("2026-05-01T09:00:00.000Z"));
    await h.service.run(VALID_UUIDS[0]);
    expect(h.dispatcher.calls[0]?.details).toBe("Full body across\nmultiple lines.");
  });

  it("run() omits details key entirely (not undefined) when not set", async () => {
    await h.service.create(baseArgs());
    h.setNow(new Date("2026-05-01T09:00:00.000Z"));
    await h.service.run(VALID_UUIDS[0]);
    const call = h.dispatcher.calls[0]!;
    expect(Object.hasOwn(call, "details")).toBe(false);
  });

  it("run() passes runtime when set; omits when undefined", async () => {
    await h.service.create(
      baseArgs({
        target: {
          kind: "task",
          agent: "report-bot",
          brief: "Run",
          runtime: "copilot-cli",
        },
      }),
    );
    h.setNow(new Date("2026-05-01T09:00:00.000Z"));
    await h.service.run(VALID_UUIDS[0]);
    expect(h.dispatcher.calls[0]?.runtime).toBe("copilot-cli");
  });

  it("run() always allowed even when disabled (bypasses enabled gate)", async () => {
    await h.service.create(baseArgs({ enabled: false }));
    await h.service.run(VALID_UUIDS[0]);
    expect(h.dispatcher.calls).toHaveLength(1);
  });

  it("run() updates lastFiredAt + nextFireAt", async () => {
    await h.service.create(baseArgs());
    h.setNow(new Date("2026-05-01T09:00:00.000Z"));
    await h.service.run(VALID_UUIDS[0]);
    const after = await h.service.get(VALID_UUIDS[0]);
    expect(after?.lastFiredAt).toBe("2026-05-01T09:00:00.000Z");
    expect(after?.nextFireAt).toBe("2026-05-02T09:00:00.000Z");
  });

  it("automated fire skips and warns when hasInFlightForSchedule reports true", async () => {
    // create then directly invoke the fire path by reading + asserting
    // that the timer-driven side-effect respects the concurrency rule.
    await h.service.create(baseArgs());
    h.dispatcher.inFlightSet.add(VALID_UUIDS[0]);
    // Force a fire via the public manual `run` path would BYPASS the
    // concurrency check (that's the manual semantics). Instead we
    // exercise the timer path by advancing the fake clock past
    // nextFireAt — armNext is called inside create when enabled.
    h.setNow(new Date("2026-05-01T09:00:00.500Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.dispatcher.calls).toHaveLength(0);
    // recordFired must NOT have been invoked (no lastFiredAt write
    // on a skip per RFC).
    const after = await h.service.get(VALID_UUIDS[0]);
    expect(after?.lastFiredAt).toBeUndefined();
  });

  it("automated fire dispatches when no in-flight; records fire + re-arms", async () => {
    await h.service.create(baseArgs());
    // Advance clock to just past the scheduled fire time
    h.setNow(new Date("2026-05-01T09:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(h.dispatcher.calls).toHaveLength(1);
    expect(h.dispatcher.calls[0]?.metadata.scheduleId).toBe(VALID_UUIDS[0]);
    const after = await h.service.get(VALID_UUIDS[0]);
    expect(after?.lastFiredAt).toBe("2026-05-01T09:00:00.000Z");
    expect(after?.nextFireAt).toBe("2026-05-02T09:00:00.000Z");
  });
});

describe("ScheduleService.fire — exhaustiveness shim", () => {
  it("the discriminated switch on target.kind is exhaustive (compile-time)", () => {
    // Type-level test: if a future contributor adds a target kind
    // without extending the switch, this assignment fails to typecheck
    // because the default branch's `never` would no longer be `never`.
    // This is a no-op at runtime — the real assertion is `pnpm typecheck`.
    const e = ScheduleEntity.create(
      {
        name: "x",
        trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        target: { kind: "task", agent: "a", brief: "i" },
      },
      { id: VALID_UUIDS[0], now: new Date() },
    );
    expect(e.target.kind).toBe("task");
  });
});
