import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ScheduleEnabledError,
  ScheduleError,
  ScheduleHasInFlightError,
  ScheduleKindMismatchError,
  ScheduleNotFoundError,
} from "../src/errors.js";
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

describe("ScheduleService.create / patch / delete", () => {
  let h: ScheduleTestHandle;

  beforeEach(() => {
    h = makeScheduleTestHandle({
      initialNow: new Date("2026-05-01T00:00:00.000Z"),
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
  });

  afterEach(async () => {
    await h.service.shutdown();
    h.close();
  });

  it("create populates id, timestamps, enabled default, and next_fire_at", async () => {
    const s = await h.service.create(baseArgs());
    expect(s.id).toBe(VALID_UUIDS[0]);
    expect(s.name).toBe("daily-report");
    expect(s.enabled).toBe(true);
    expect(s.createdAt).toBe("2026-05-01T00:00:00.000Z");
    expect(s.updatedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(s.lastFiredAt).toBeUndefined();
    expect(s.nextFireAt).toBe("2026-05-01T09:00:00.000Z");
    expect(s.target.kind).toBe("task");
    expect(s.target.data).toEqual({ agent: "report-bot", brief: "Run the daily report" });
  });

  it("create with enabled=false does NOT pre-arm next_fire_at", async () => {
    const s = await h.service.create(baseArgs({ enabled: false }));
    expect(s.enabled).toBe(false);
    expect(s.nextFireAt).toBeUndefined();
  });

  it("create routes through handler.validate (called BEFORE entity construction)", async () => {
    await h.service.create(baseArgs());
    expect(h.taskHandler.validateCalls).toHaveLength(1);
    expect(h.taskHandler.validateCalls[0]?.data).toEqual({
      agent: "report-bot",
      brief: "Run the daily report",
    });
    expect(h.taskHandler.validateCalls[0]?.changedKeys).toBeUndefined();
  });

  it("create runs schedule-level invariants BEFORE handler.validate (regression: catalog stub throws would mask the real error)", async () => {
    // The synchronous-first invariant. The handler's validate would
    // throw "fake catalog error" if called; but with a bad name
    // we never reach it — the service rejects synchronously.
    let validateCalled = false;
    h.taskHandler.validate = async () => {
      validateCalled = true;
      throw new Error("fake catalog error");
    };
    await expect(h.service.create(baseArgs({ name: "" }))).rejects.toThrow(ScheduleError);
    expect(validateCalled).toBe(false);
  });

  it("create propagates handler.validate rejections (e.g. catalog miss)", async () => {
    h.taskHandler.validate = async () => {
      throw new Error("agent not found");
    };
    await expect(h.service.create(baseArgs())).rejects.toThrow("agent not found");
  });

  it("get returns the wire DTO; null when missing", async () => {
    await h.service.create(baseArgs());
    const got = await h.service.get(VALID_UUIDS[0]);
    expect(got?.name).toBe("daily-report");
    const missing = await h.service.get("550e8400-e29b-41d4-a716-44665544aaaa");
    expect(missing).toBeNull();
  });

  it("list filters by enabled flag", async () => {
    await h.service.create(baseArgs({ name: "a", enabled: true }));
    await h.service.create(baseArgs({ name: "b", enabled: false }));
    const enabled = await h.service.list({ enabled: true });
    expect(enabled.map((s) => s.name)).toEqual(["a"]);
    const disabled = await h.service.list({ enabled: false });
    expect(disabled.map((s) => s.name)).toEqual(["b"]);
  });

  it("list filters by generic dataEquals { kind, path, value } (replaces old agent filter)", async () => {
    await h.service.create(baseArgs({ name: "a" }));
    await h.service.create(
      baseArgs({
        name: "b",
        target: { kind: "task", data: { agent: "other-bot", brief: "x" } },
      }),
    );
    const filtered = await h.service.list({
      kind: "task",
      dataEquals: { path: "$.agent", value: "report-bot" },
    });
    expect(filtered.map((s) => s.name)).toEqual(["a"]);
  });

  it("patch(name) updates name and stamps updatedAt; preserves nextFireAt", async () => {
    await h.service.create(baseArgs());
    h.setNow(new Date("2026-05-01T01:00:00.000Z"));
    const p = await h.service.patch(VALID_UUIDS[0]!, { name: "renamed" });
    expect(p.name).toBe("renamed");
    expect(p.updatedAt).toBe("2026-05-01T01:00:00.000Z");
    expect(p.nextFireAt).toBe("2026-05-01T09:00:00.000Z");
  });

  it("patch(trigger) recomputes nextFireAt", async () => {
    await h.service.create(baseArgs());
    h.setNow(new Date("2026-05-01T00:30:00.000Z"));
    const p = await h.service.patch(VALID_UUIDS[0]!, {
      trigger: { kind: "cron", expr: "0 10 * * *", tz: "UTC" },
    });
    expect(p.nextFireAt).toBe("2026-05-01T10:00:00.000Z");
  });

  it("patch(enabled: true → false) clears nextFireAt", async () => {
    await h.service.create(baseArgs());
    const p = await h.service.patch(VALID_UUIDS[0]!, { enabled: false });
    expect(p.enabled).toBe(false);
    expect(p.nextFireAt).toBeUndefined();
  });

  it("patch(enabled: false → true) recomputes nextFireAt", async () => {
    await h.service.create(baseArgs({ enabled: false }));
    h.setNow(new Date("2026-05-01T05:00:00.000Z"));
    const p = await h.service.patch(VALID_UUIDS[0]!, { enabled: true });
    expect(p.enabled).toBe(true);
    expect(p.nextFireAt).toBe("2026-05-01T09:00:00.000Z");
  });

  it("patch on missing id throws ScheduleNotFoundError", async () => {
    await expect(
      h.service.patch("550e8400-e29b-41d4-a716-44665544aaaa", { name: "x" }),
    ).rejects.toThrow(ScheduleNotFoundError);
  });

  it("patch(expectedKind) throws ScheduleKindMismatchError when current kind differs", async () => {
    await h.service.create(baseArgs());
    // The seeded schedule has kind="task". A patch with
    // expectedKind="workflow" must surface the mismatch (the route
    // layer projects this to 404).
    await expect(
      h.service.patch(VALID_UUIDS[0]!, { name: "x", expectedKind: "workflow" }),
    ).rejects.toBeInstanceOf(ScheduleKindMismatchError);
  });

  it("patch without expectedKind does NOT enforce the kind check (forward-compat for polymorphic patches)", async () => {
    await h.service.create(baseArgs());
    // No expectedKind set: any registered kind passes. The seeded
    // task schedule patches happily.
    const p = await h.service.patch(VALID_UUIDS[0]!, { name: "renamed" });
    expect(p.name).toBe("renamed");
  });

  it("patch(target) routes through handler.mergePatch then handler.validate({ changedKeys })", async () => {
    await h.service.create(baseArgs());
    // Default stub's mergePatch returns {...existing, ...patch} so
    // the merged data carries the new brief on top of the seeded agent.
    h.taskHandler.validateCalls.length = 0;
    h.taskHandler.mergePatchCalls.length = 0;
    const p = await h.service.patch(VALID_UUIDS[0]!, {
      target: { patch: { brief: "new brief" } },
    });
    expect(h.taskHandler.mergePatchCalls).toHaveLength(1);
    expect(h.taskHandler.mergePatchCalls[0]?.existing).toEqual({
      agent: "report-bot",
      brief: "Run the daily report",
    });
    expect(h.taskHandler.mergePatchCalls[0]?.patch).toEqual({ brief: "new brief" });
    expect(h.taskHandler.validateCalls).toHaveLength(1);
    expect(h.taskHandler.validateCalls[0]?.changedKeys).toEqual(["brief"]);
    // Merged data persisted in target.data.
    expect(p.target.kind).toBe("task");
    expect(p.target.data).toEqual({ agent: "report-bot", brief: "new brief" });
  });

  it("delete throws ScheduleEnabledError when enabled", async () => {
    await h.service.create(baseArgs());
    await expect(h.service.delete(VALID_UUIDS[0]!)).rejects.toThrow(ScheduleEnabledError);
  });

  it("delete throws ScheduleHasInFlightError when handler reports in-flight", async () => {
    await h.service.create(baseArgs({ enabled: false }));
    h.taskHandler.inFlightSet.add(VALID_UUIDS[0]!);
    await expect(h.service.delete(VALID_UUIDS[0]!)).rejects.toThrow(ScheduleHasInFlightError);
  });

  it("delete succeeds when disabled and no in-flight (returns deletedDispatchCount: 0)", async () => {
    await h.service.create(baseArgs({ enabled: false }));
    const result = await h.service.delete(VALID_UUIDS[0]!);
    expect(result).toEqual({ deletedDispatchCount: 0 });
    expect(await h.service.get(VALID_UUIDS[0]!)).toBeNull();
  });

  it("delete cascades historical dispatches via handler.deleteForSchedule and surfaces the count", async () => {
    await h.service.create(baseArgs({ enabled: false }));
    h.taskHandler.deleteReturns.set(VALID_UUIDS[0]!, { deletedCount: 5 });
    const result = await h.service.delete(VALID_UUIDS[0]!);
    expect(result).toEqual({ deletedDispatchCount: 5 });
    expect(h.taskHandler.deleteCalls).toEqual([VALID_UUIDS[0]]);
    expect(await h.service.get(VALID_UUIDS[0]!)).toBeNull();
  });

  it("delete refuses if a manual run() races a fresh dispatch in between checks (TOCTOU)", async () => {
    // Simulate: original `hasInFlight` returns false, cascade runs,
    // then a concurrent run() inserts a new dispatch → second
    // `hasInFlight` returns true → service must refuse the row
    // delete so we never orphan a running unit-of-work pointing to
    // a dead schedule.
    await h.service.create(baseArgs({ enabled: false }));
    const sid = VALID_UUIDS[0]!;
    let hasInFlightCalls = 0;
    h.taskHandler.hasInFlightForSchedule = async () => {
      hasInFlightCalls += 1;
      // First call (pre-flight): clean. Second call (post-cascade):
      // a racing manual run snuck a fresh dispatch in.
      return hasInFlightCalls > 1;
    };
    h.taskHandler.deleteReturns.set(sid, { deletedCount: 2 });
    await expect(h.service.delete(sid)).rejects.toThrow(ScheduleHasInFlightError);
    expect(hasInFlightCalls).toBe(2);
    expect(h.taskHandler.deleteCalls).toEqual([sid]);
    // Schedule row must still exist — we refused to commit.
    expect(await h.service.get(sid)).not.toBeNull();
  });

  it("delete on missing id throws ScheduleNotFoundError", async () => {
    await expect(h.service.delete("550e8400-e29b-41d4-a716-44665544aaaa")).rejects.toThrow(
      ScheduleNotFoundError,
    );
  });
});
