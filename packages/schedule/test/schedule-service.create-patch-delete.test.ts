import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentNotFoundError,
  AgentResolutionFailedError,
  ScheduleEnabledError,
  ScheduleHasInFlightError,
  ScheduleNotFoundError,
} from "../src/errors.js";
import type { CreateTaskScheduleArgs } from "../src/types.js";
import {
  fixedRandomUUID,
  makeScheduleTestHandle,
  rejectAgentAsNotFound,
  rejectAgentWithFault,
  type ScheduleTestHandle,
  VALID_UUIDS,
} from "./_helpers.js";

function baseArgs(over: Partial<CreateTaskScheduleArgs> = {}): CreateTaskScheduleArgs {
  return {
    name: "daily-report",
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: { agent: "report-bot", brief: "Run the daily report" },
    ...over,
  };
}

describe("ScheduleService.createTask / patchTask / delete", () => {
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

  it("createTask populates id, timestamps, enabled default, and next_fire_at", async () => {
    const s = await h.service.createTask(baseArgs());
    expect(s.id).toBe(VALID_UUIDS[0]);
    expect(s.name).toBe("daily-report");
    expect(s.enabled).toBe(true);
    expect(s.createdAt).toBe("2026-05-01T00:00:00.000Z");
    expect(s.updatedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(s.lastFiredAt).toBeUndefined();
    expect(s.nextFireAt).toBe("2026-05-01T09:00:00.000Z");
    // The service injects `kind: "task"` from the URL-discriminated args.
    expect(s.target.kind).toBe("task");
  });

  it("createTask with enabled=false does NOT pre-arm next_fire_at", async () => {
    const s = await h.service.createTask(baseArgs({ enabled: false }));
    expect(s.enabled).toBe(false);
    expect(s.nextFireAt).toBeUndefined();
  });

  it("createTask surfaces the agentValidator rejection as AgentNotFoundError", async () => {
    const handle = makeScheduleTestHandle({
      agentValidator: rejectAgentAsNotFound,
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
    try {
      await expect(handle.service.createTask(baseArgs())).rejects.toBeInstanceOf(
        AgentNotFoundError,
      );
    } finally {
      await handle.service.shutdown();
      handle.close();
    }
  });

  it("createTask wraps a non-not-found validator fault as AgentResolutionFailedError (500)", async () => {
    // The schedule-agent-validator throws schedule's own typed
    // AgentNotFoundError on null catalog lookup; anything else (DB
    // exploded, parser crashed) must surface as a system fault,
    // NOT a misleading 400 'agent not found'. Destructive
    // validation for the `instanceof AgentNotFoundError` branch in
    // schedule-service.ts: removing it collapses this back to
    // AgentNotFoundError and the assertions below must fail.
    const cause = new Error("DB exploded");
    const handle = makeScheduleTestHandle({
      agentValidator: rejectAgentWithFault(cause),
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
    try {
      const err = await handle.service.createTask(baseArgs()).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(AgentResolutionFailedError);
      expect(err).not.toBeInstanceOf(AgentNotFoundError);
      expect((err as AgentResolutionFailedError).agent).toBe("report-bot");
      expect((err as AgentResolutionFailedError).cause).toBeInstanceOf(Error);
      expect(((err as AgentResolutionFailedError).cause as Error).message).toBe("DB exploded");
    } finally {
      await handle.service.shutdown();
      handle.close();
    }
  });

  it("get returns the wire DTO; null when missing", async () => {
    await h.service.createTask(baseArgs());
    const got = await h.service.get(VALID_UUIDS[0]);
    expect(got?.name).toBe("daily-report");
    const missing = await h.service.get("550e8400-e29b-41d4-a716-44665544aaaa");
    expect(missing).toBeNull();
  });

  it("list filters by enabled flag", async () => {
    await h.service.createTask(baseArgs({ name: "a", enabled: true }));
    await h.service.createTask(baseArgs({ name: "b", enabled: false }));
    const enabled = await h.service.list({ enabled: true });
    expect(enabled.map((s) => s.name)).toEqual(["a"]);
    const disabled = await h.service.list({ enabled: false });
    expect(disabled.map((s) => s.name)).toEqual(["b"]);
  });

  it("list filters by target.agent", async () => {
    await h.service.createTask(baseArgs({ name: "a" }));
    await h.service.createTask(
      baseArgs({
        name: "b",
        target: { agent: "other-bot", brief: "x" },
      }),
    );
    const filtered = await h.service.list({ agent: "report-bot" });
    expect(filtered.map((s) => s.name)).toEqual(["a"]);
  });

  it("patchTask(name) updates name and stamps updatedAt; preserves nextFireAt", async () => {
    await h.service.createTask(baseArgs());
    h.setNow(new Date("2026-05-01T01:00:00.000Z"));
    const p = await h.service.patchTask(VALID_UUIDS[0]!, { name: "renamed" });
    expect(p.name).toBe("renamed");
    expect(p.updatedAt).toBe("2026-05-01T01:00:00.000Z");
    expect(p.nextFireAt).toBe("2026-05-01T09:00:00.000Z");
  });

  it("patchTask(trigger) recomputes nextFireAt", async () => {
    await h.service.createTask(baseArgs());
    h.setNow(new Date("2026-05-01T00:30:00.000Z"));
    const p = await h.service.patchTask(VALID_UUIDS[0]!, {
      trigger: { kind: "cron", expr: "0 10 * * *", tz: "UTC" },
    });
    expect(p.nextFireAt).toBe("2026-05-01T10:00:00.000Z");
  });

  it("patchTask(enabled: true → false) clears nextFireAt", async () => {
    await h.service.createTask(baseArgs());
    const p = await h.service.patchTask(VALID_UUIDS[0]!, { enabled: false });
    expect(p.enabled).toBe(false);
    expect(p.nextFireAt).toBeUndefined();
  });

  it("patchTask(enabled: false → true) recomputes nextFireAt", async () => {
    await h.service.createTask(baseArgs({ enabled: false }));
    h.setNow(new Date("2026-05-01T05:00:00.000Z"));
    const p = await h.service.patchTask(VALID_UUIDS[0]!, { enabled: true });
    expect(p.enabled).toBe(true);
    expect(p.nextFireAt).toBe("2026-05-01T09:00:00.000Z");
  });

  it("patchTask on missing id throws ScheduleNotFoundError", async () => {
    await expect(
      h.service.patchTask("550e8400-e29b-41d4-a716-44665544aaaa", { name: "x" }),
    ).rejects.toThrow(ScheduleNotFoundError);
  });

  // Regression for #226: a sparse target patch must NOT wipe siblings
  // (the old `withPatched` did wholesale replace, which silently
  // dropped agent/brief when the caller only sent { details }).
  it("patchTask(sparse target.details) preserves agent / brief", async () => {
    await h.service.createTask(
      baseArgs({
        target: {
          agent: "report-bot",
          brief: "Run the daily report",
          runtime: "node-22",
        },
      }),
    );
    const p = await h.service.patchTask(VALID_UUIDS[0]!, {
      target: { details: "with extra context" },
    });
    expect(p.target.kind).toBe("task");
    if (p.target.kind === "task") {
      expect(p.target.agent).toBe("report-bot");
      expect(p.target.brief).toBe("Run the daily report");
      expect(p.target.details).toBe("with extra context");
      expect(p.target.runtime).toBe("node-22");
    }
  });

  // RFC 7396: `null` on `details` deletes the field, sibling agent / brief
  // / runtime unchanged.
  it("patchTask(target.details: null) deletes details only", async () => {
    await h.service.createTask(
      baseArgs({
        target: {
          agent: "report-bot",
          brief: "x",
          details: "old details",
          runtime: "node-22",
        },
      }),
    );
    const p = await h.service.patchTask(VALID_UUIDS[0]!, {
      target: { details: null },
    });
    if (p.target.kind === "task") {
      expect(p.target.details).toBeUndefined();
      expect(p.target.runtime).toBe("node-22");
      expect(p.target.agent).toBe("report-bot");
    }
  });

  it("patchTask(target.runtime: null) deletes runtime only", async () => {
    await h.service.createTask(
      baseArgs({
        target: {
          agent: "report-bot",
          brief: "x",
          details: "keep me",
          runtime: "node-22",
        },
      }),
    );
    const p = await h.service.patchTask(VALID_UUIDS[0]!, {
      target: { runtime: null },
    });
    if (p.target.kind === "task") {
      expect(p.target.runtime).toBeUndefined();
      expect(p.target.details).toBe("keep me");
    }
  });

  // agentValidator is only invoked when the patch supplies an agent
  // string. Non-agent target patches (brief / details / runtime only)
  // skip the async lookup so a target-only edit never surfaces a
  // misleading "agent not found" 404.
  it("patchTask without target.agent does not invoke agentValidator", async () => {
    await h.service.createTask(baseArgs());
    const rejectingHandle = makeScheduleTestHandle({
      agentValidator: rejectAgentAsNotFound,
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
    try {
      const repoBacked = new (await import("../src/schedule-repository.js")).ScheduleRepository({
        db: h.db.db,
      });
      const Svc = (await import("../src/schedule-service.js")).ScheduleService;
      const svc = new Svc({
        repo: repoBacked,
        taskDispatcher: h.dispatcher,
        agentValidator: rejectAgentAsNotFound,
        now: () => h.nowRef.value,
        randomUUID: fixedRandomUUID(VALID_UUIDS),
      });
      // No `target.agent` in the patch ⇒ rejecting validator must not run.
      await expect(
        svc.patchTask(VALID_UUIDS[0]!, { target: { brief: "new brief" } }),
      ).resolves.toMatchObject({ id: VALID_UUIDS[0] });
      await svc.shutdown();
    } finally {
      await rejectingHandle.service.shutdown();
      rejectingHandle.close();
    }
  });

  it("delete throws ScheduleEnabledError when enabled", async () => {
    await h.service.createTask(baseArgs());
    await expect(h.service.delete(VALID_UUIDS[0]!)).rejects.toThrow(ScheduleEnabledError);
  });

  it("delete throws ScheduleHasInFlightError when dispatcher reports in-flight", async () => {
    await h.service.createTask(baseArgs({ enabled: false }));
    h.dispatcher.inFlightSet.add(VALID_UUIDS[0]!);
    await expect(h.service.delete(VALID_UUIDS[0]!)).rejects.toThrow(ScheduleHasInFlightError);
  });

  it("delete succeeds when disabled and no in-flight", async () => {
    await h.service.createTask(baseArgs({ enabled: false }));
    const result = await h.service.delete(VALID_UUIDS[0]!);
    expect(result).toEqual({ deletedTaskCount: 0 });
    expect(await h.service.get(VALID_UUIDS[0]!)).toBeNull();
  });

  it("delete cascades historical tasks via dispatcher and surfaces the count", async () => {
    await h.service.createTask(baseArgs({ enabled: false }));
    h.dispatcher.deleteForScheduleReturns.set(VALID_UUIDS[0]!, { deletedCount: 5 });
    const result = await h.service.delete(VALID_UUIDS[0]!);
    expect(result).toEqual({ deletedTaskCount: 5 });
    expect(h.dispatcher.deleteForScheduleCalls).toEqual([VALID_UUIDS[0]]);
    expect(await h.service.get(VALID_UUIDS[0]!)).toBeNull();
  });

  it("delete refuses if a manual run() races a fresh task in between checks (TOCTOU)", async () => {
    // Simulate: original `hasInFlight` returns false, cascade runs,
    // then a concurrent run() inserts a new task → second
    // `hasInFlight` returns true → service must refuse the row
    // delete so we never orphan a running task pointing to a dead
    // schedule.
    await h.service.createTask(baseArgs({ enabled: false }));
    const sid = VALID_UUIDS[0]!;
    let hasInFlightCalls = 0;
    h.dispatcher.hasInFlightForSchedule = async () => {
      hasInFlightCalls += 1;
      // First call (pre-flight): clean. Second call (post-cascade):
      // a racing manual run snuck a fresh running task in.
      return hasInFlightCalls > 1;
    };
    h.dispatcher.deleteForScheduleReturns.set(sid, { deletedCount: 2 });
    await expect(h.service.delete(sid)).rejects.toThrow(ScheduleHasInFlightError);
    expect(hasInFlightCalls).toBe(2);
    expect(h.dispatcher.deleteForScheduleCalls).toEqual([sid]);
    // Schedule row must still exist — we refused to commit.
    expect(await h.service.get(sid)).not.toBeNull();
  });

  it("delete on missing id throws ScheduleNotFoundError", async () => {
    await expect(h.service.delete("550e8400-e29b-41d4-a716-44665544aaaa")).rejects.toThrow(
      ScheduleNotFoundError,
    );
  });

  it("patchTask with bad target agent surfaces AgentNotFoundError", async () => {
    // Seed a schedule with accept-all validator, then patch with a
    // service that has a rejecting validator. The rejecting service
    // shares the same DB so the patched record exists.
    await h.service.createTask(baseArgs());
    const rejectingHandle = makeScheduleTestHandle({
      agentValidator: rejectAgentAsNotFound,
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
        agentValidator: rejectAgentAsNotFound,
        now: () => h.nowRef.value,
        randomUUID: fixedRandomUUID(VALID_UUIDS),
      });
      await expect(
        svc.patchTask(VALID_UUIDS[0]!, {
          target: { agent: "missing-bot" },
        }),
      ).rejects.toBeInstanceOf(AgentNotFoundError);
      await svc.shutdown();
    } finally {
      await rejectingHandle.service.shutdown();
      rejectingHandle.close();
    }
  });
});
