import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentNotFoundError,
  ScheduleEnabledError,
  ScheduleHasInFlightError,
  ScheduleNotFoundError,
} from "../src/errors.js";
import type { CreateScheduleArgs } from "../src/types.js";
import {
  fixedRandomUUID,
  makeScheduleTestHandle,
  rejectAgent,
  type ScheduleTestHandle,
  VALID_UUIDS,
} from "./_helpers.js";

function baseArgs(over: Partial<CreateScheduleArgs> = {}): CreateScheduleArgs {
  return {
    name: "daily-report",
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: { kind: "task", agent: "report-bot", instructions: "Run the daily report" },
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
  });

  it("create with enabled=false does NOT pre-arm next_fire_at", async () => {
    const s = await h.service.create(baseArgs({ enabled: false }));
    expect(s.enabled).toBe(false);
    expect(s.nextFireAt).toBeUndefined();
  });

  it("create surfaces the agentValidator rejection as AgentNotFoundError", async () => {
    const handle = makeScheduleTestHandle({
      agentValidator: rejectAgent,
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
    try {
      await expect(handle.service.create(baseArgs())).rejects.toThrow(AgentNotFoundError);
    } finally {
      await handle.service.shutdown();
      handle.close();
    }
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

  it("list filters by target.agent", async () => {
    await h.service.create(baseArgs({ name: "a" }));
    await h.service.create(
      baseArgs({
        name: "b",
        target: { kind: "task", agent: "other-bot", instructions: "x" },
      }),
    );
    const filtered = await h.service.list({ agent: "report-bot" });
    expect(filtered.map((s) => s.name)).toEqual(["a"]);
  });

  it("patch(name) updates name and stamps updatedAt; preserves nextFireAt", async () => {
    await h.service.create(baseArgs());
    h.setNow(new Date("2026-05-01T01:00:00.000Z"));
    const p = await h.service.patch(VALID_UUIDS[0], { name: "renamed" });
    expect(p.name).toBe("renamed");
    expect(p.updatedAt).toBe("2026-05-01T01:00:00.000Z");
    expect(p.nextFireAt).toBe("2026-05-01T09:00:00.000Z");
  });

  it("patch(trigger) recomputes nextFireAt", async () => {
    await h.service.create(baseArgs());
    h.setNow(new Date("2026-05-01T00:30:00.000Z"));
    const p = await h.service.patch(VALID_UUIDS[0], {
      trigger: { kind: "cron", expr: "0 10 * * *", tz: "UTC" },
    });
    expect(p.nextFireAt).toBe("2026-05-01T10:00:00.000Z");
  });

  it("patch(enabled: true → false) clears nextFireAt", async () => {
    await h.service.create(baseArgs());
    const p = await h.service.patch(VALID_UUIDS[0], { enabled: false });
    expect(p.enabled).toBe(false);
    expect(p.nextFireAt).toBeUndefined();
  });

  it("patch(enabled: false → true) recomputes nextFireAt", async () => {
    await h.service.create(baseArgs({ enabled: false }));
    h.setNow(new Date("2026-05-01T05:00:00.000Z"));
    const p = await h.service.patch(VALID_UUIDS[0], { enabled: true });
    expect(p.enabled).toBe(true);
    expect(p.nextFireAt).toBe("2026-05-01T09:00:00.000Z");
  });

  it("patch on missing id throws ScheduleNotFoundError", async () => {
    await expect(
      h.service.patch("550e8400-e29b-41d4-a716-44665544aaaa", { name: "x" }),
    ).rejects.toThrow(ScheduleNotFoundError);
  });

  it("delete throws ScheduleEnabledError when enabled", async () => {
    await h.service.create(baseArgs());
    await expect(h.service.delete(VALID_UUIDS[0])).rejects.toThrow(ScheduleEnabledError);
  });

  it("delete throws ScheduleHasInFlightError when dispatcher reports in-flight", async () => {
    await h.service.create(baseArgs({ enabled: false }));
    h.dispatcher.inFlightSet.add(VALID_UUIDS[0]);
    await expect(h.service.delete(VALID_UUIDS[0])).rejects.toThrow(ScheduleHasInFlightError);
  });

  it("delete succeeds when disabled and no in-flight", async () => {
    await h.service.create(baseArgs({ enabled: false }));
    await h.service.delete(VALID_UUIDS[0]);
    expect(await h.service.get(VALID_UUIDS[0])).toBeNull();
  });

  it("delete on missing id throws ScheduleNotFoundError", async () => {
    await expect(h.service.delete("550e8400-e29b-41d4-a716-44665544aaaa")).rejects.toThrow(
      ScheduleNotFoundError,
    );
  });

  it("patch with bad target agent surfaces AgentNotFoundError", async () => {
    // Seed a schedule with accept-all validator, then patch with a
    // service that has a rejecting validator. The rejecting service
    // shares the same DB so the patched record exists.
    await h.service.create(baseArgs());
    const rejectingHandle = makeScheduleTestHandle({
      agentValidator: rejectAgent,
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
    try {
      // Wire the rejecting service to the SAME underlying DB by
      // bypassing makeScheduleTestHandle's fresh-DB default: we
      // instead manually thread the existing repo.
      const repoBacked = new (await import("../src/schedule-repository.js")).ScheduleRepository({
        db: h.db.db,
      });
      const Svc = (await import("../src/schedule-service.js")).ScheduleService;
      const svc = new Svc({
        repo: repoBacked,
        taskDispatcher: h.dispatcher,
        agentValidator: rejectAgent,
        now: () => h.nowRef.value,
        randomUUID: fixedRandomUUID(VALID_UUIDS),
      });
      await expect(
        svc.patch(VALID_UUIDS[0], {
          target: { kind: "task", agent: "missing-bot", instructions: "x" },
        }),
      ).rejects.toThrow(AgentNotFoundError);
      await svc.shutdown();
    } finally {
      await rejectingHandle.service.shutdown();
      rejectingHandle.close();
    }
  });
});
