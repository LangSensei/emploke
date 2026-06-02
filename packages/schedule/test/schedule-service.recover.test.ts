import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleKindNotRegisteredError, ScheduleKindRegistryFrozenError } from "../src/errors.js";
import { ScheduleEntity } from "../src/schedule-entity.js";
import { ScheduleRepository } from "../src/schedule-repository.js";
import { ScheduleService } from "../src/schedule-service.js";
import { openTestScheduleDb } from "../src/testing.js";
import type { CreateScheduleArgs } from "../src/types.js";
import { fixedRandomUUID, makeStubHandler, VALID_UUIDS } from "./_helpers.js";

function baseArgs(over: Partial<CreateScheduleArgs> = {}): CreateScheduleArgs {
  return {
    name: "daily-report",
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: { kind: "task", data: { agent: "report-bot", brief: "Run the daily report" } },
    ...over,
  };
}

describe("ScheduleService.recover", () => {
  let db: ReturnType<typeof openTestScheduleDb>;
  let repo: ScheduleRepository;
  let handler: ReturnType<typeof makeStubHandler>;
  let service: ScheduleService;
  let nowRef: { value: Date };

  beforeEach(() => {
    vi.useFakeTimers();
    db = openTestScheduleDb();
    repo = new ScheduleRepository({ db: db.db });
    handler = makeStubHandler();
    nowRef = { value: new Date("2026-05-02T00:00:00.000Z") };
    service = new ScheduleService({
      repo,
      now: () => nowRef.value,
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
    service.registerKind("task", handler);
  });

  afterEach(async () => {
    await service.shutdown();
    db.close();
    vi.useRealTimers();
  });

  it("catchup-fires EXACTLY ONCE for an enabled schedule with past next_fire_at, using planned firedAt", async () => {
    // Seed a schedule whose next_fire_at is 6 hours before now.
    const plannedFireIso = "2026-05-01T18:00:00.000Z";
    const entity = ScheduleEntity.create(baseArgs(), {
      id: VALID_UUIDS[0],
      now: new Date("2026-05-01T00:00:00.000Z"),
    }).withFired("2026-05-01T09:00:00.000Z", plannedFireIso);
    await repo.insert(entity);

    await service.recover();

    expect(handler.dispatchCalls).toHaveLength(1);
    const call = handler.dispatchCalls[0]!;
    // firedAt is the PLANNED past time, not `now`.
    expect(call.firedAt).toBe(plannedFireIso);
    expect(call.scheduleId).toBe(VALID_UUIDS[0]);
    // After recover, recorded last_fired_at = planned, next_fire_at = next from now.
    const after = await service.get(VALID_UUIDS[0]);
    expect(after?.lastFiredAt).toBe(plannedFireIso);
    expect(after?.nextFireAt).toBe("2026-05-02T09:00:00.000Z");
  });

  it("multiple missed fires collapse into ONE catchup", async () => {
    // Set next_fire_at to 3 days in the past — without catchup-once
    // we'd dispatch dozens of times.
    const entity = ScheduleEntity.create(baseArgs(), {
      id: VALID_UUIDS[0],
      now: new Date("2026-04-28T00:00:00.000Z"),
    }).withFired("2026-04-28T09:00:00.000Z", "2026-04-29T09:00:00.000Z");
    await repo.insert(entity);

    await service.recover();

    expect(handler.dispatchCalls).toHaveLength(1);
  });

  it("arms timer (no dispatch) for an enabled schedule with FUTURE next_fire_at", async () => {
    const entity = ScheduleEntity.create(baseArgs(), {
      id: VALID_UUIDS[0],
      now: nowRef.value,
    }).withNextFireAt("2026-05-02T09:00:00.000Z");
    await repo.insert(entity);

    await service.recover();
    expect(handler.dispatchCalls).toHaveLength(0);

    // Advance to the scheduled time — the armed timer should fire.
    nowRef.value = new Date("2026-05-02T09:00:00.000Z");
    await vi.advanceTimersByTimeAsync(10 * 60 * 60_000);
    expect(handler.dispatchCalls).toHaveLength(1);
  });

  it("skips disabled schedules entirely (after preflight)", async () => {
    const entity = ScheduleEntity.create(baseArgs({ enabled: false }), {
      id: VALID_UUIDS[0],
      now: new Date("2026-05-01T00:00:00.000Z"),
    }).withFired("2026-05-01T09:00:00.000Z", "2026-05-01T18:00:00.000Z");
    await repo.insert(entity);

    await service.recover();
    expect(handler.dispatchCalls).toHaveLength(0);
    // last_fired_at / next_fire_at must not be rewritten.
    const after = await service.get(VALID_UUIDS[0]);
    expect(after?.lastFiredAt).toBe("2026-05-01T09:00:00.000Z");
    expect(after?.nextFireAt).toBe("2026-05-01T18:00:00.000Z");
  });

  it("recover is idempotent (second call is a no-op; no double-arming)", async () => {
    const entity = ScheduleEntity.create(baseArgs(), {
      id: VALID_UUIDS[0],
      now: nowRef.value,
    }).withNextFireAt("2026-05-02T09:00:00.000Z");
    await repo.insert(entity);

    await service.recover();
    await service.recover(); // second call no-ops (registry stays frozen)

    nowRef.value = new Date("2026-05-02T09:00:00.000Z");
    await vi.advanceTimersByTimeAsync(10 * 60 * 60_000);
    // Only ONE fire from the single armed timer — not two.
    expect(handler.dispatchCalls).toHaveLength(1);
  });

  it("registerKind after recover throws ScheduleKindRegistryFrozenError", async () => {
    await service.recover();
    expect(() => service.registerKind("workflow", makeStubHandler())).toThrow(
      ScheduleKindRegistryFrozenError,
    );
  });

  it("recover preflight throws when an ENABLED row's kind has no registered handler", async () => {
    const otherDb = openTestScheduleDb();
    const otherRepo = new ScheduleRepository({ db: otherDb.db });
    const otherSvc = new ScheduleService({
      repo: otherRepo,
      now: () => nowRef.value,
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
    otherSvc.registerKind("task", makeStubHandler());
    try {
      // Insert a row whose target_kind = "workflow" directly via
      // raw SQL — the public service surface refuses unregistered
      // kinds at create time, so we have to bypass it to seed the
      // preflight target.
      const row = ScheduleEntity.create(baseArgs(), {
        id: VALID_UUIDS[0],
        now: nowRef.value,
      }).toRow();
      otherDb.sqlite
        .prepare(
          "INSERT INTO schedules (id, name, trigger_kind, trigger_expr, trigger_tz, target_kind, target_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'workflow', ?, 1, ?, ?)",
        )
        .run(
          row.id,
          row.name,
          row.triggerKind,
          row.triggerExpr,
          row.triggerTz,
          row.targetJson,
          row.createdAt,
          row.updatedAt,
        );
      const err = await otherSvc.recover().then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ScheduleKindNotRegisteredError);
      expect((err as Error).message).toMatch(/workflow/);
      expect((err as Error).message).toMatch(/registerKind/);
    } finally {
      await otherSvc.shutdown();
      otherDb.close();
    }
  });

  it("recover preflight throws when a DISABLED row's kind has no registered handler (orphan-row gate)", async () => {
    const otherDb = openTestScheduleDb();
    const otherRepo = new ScheduleRepository({ db: otherDb.db });
    const otherSvc = new ScheduleService({
      repo: otherRepo,
      now: () => nowRef.value,
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
    otherSvc.registerKind("task", makeStubHandler());
    try {
      const row = ScheduleEntity.create(baseArgs({ enabled: false }), {
        id: VALID_UUIDS[0],
        now: nowRef.value,
      }).toRow();
      otherDb.sqlite
        .prepare(
          "INSERT INTO schedules (id, name, trigger_kind, trigger_expr, trigger_tz, target_kind, target_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'workflow', ?, 0, ?, ?)",
        )
        .run(
          row.id,
          row.name,
          row.triggerKind,
          row.triggerExpr,
          row.triggerTz,
          row.targetJson,
          row.createdAt,
          row.updatedAt,
        );
      await expect(otherSvc.recover()).rejects.toBeInstanceOf(ScheduleKindNotRegisteredError);
    } finally {
      await otherSvc.shutdown();
      otherDb.close();
    }
  });

  it("after recover() preflight failure, registry stays frozen (dead-service state)", async () => {
    // Pins the documented preflight-failure semantics: a failed
    // recover() throws but leaves the registry frozen, so the only
    // valid recovery path is dispose-and-rebuild. Seeded via the
    // same raw-SQL pattern the preflight tests above use.
    const otherDb = openTestScheduleDb();
    const otherRepo = new ScheduleRepository({ db: otherDb.db });
    const otherSvc = new ScheduleService({
      repo: otherRepo,
      now: () => nowRef.value,
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
    const taskStub = makeStubHandler();
    otherSvc.registerKind("task", taskStub);
    try {
      const row = ScheduleEntity.create(baseArgs({ enabled: false }), {
        id: VALID_UUIDS[0],
        now: nowRef.value,
      }).toRow();
      otherDb.sqlite
        .prepare(
          "INSERT INTO schedules (id, name, trigger_kind, trigger_expr, trigger_tz, target_kind, target_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'workflow', ?, 0, ?, ?)",
        )
        .run(
          row.id,
          row.name,
          row.triggerKind,
          row.triggerExpr,
          row.triggerTz,
          row.targetJson,
          row.createdAt,
          row.updatedAt,
        );

      // Act 1: first recover() throws on preflight.
      await expect(otherSvc.recover()).rejects.toBeInstanceOf(ScheduleKindNotRegisteredError);

      // Assert 1: registry is frozen — registerKind throws.
      expect(() => otherSvc.registerKind("workflow", makeStubHandler())).toThrow(
        ScheduleKindRegistryFrozenError,
      );

      // Assert 2: second recover() is a no-op (returns undefined,
      // does NOT re-throw, does NOT re-run preflight).
      await expect(otherSvc.recover()).resolves.toBeUndefined();

      // Assert 3: no timers were armed (recover() throws BEFORE the
      // arming loop, and the second recover() short-circuits at the
      // frozen-registry guard). Advancing a full day of fake time
      // proves no late-armed timer fires.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(taskStub.dispatchCalls).toHaveLength(0);
    } finally {
      await otherSvc.shutdown();
      otherDb.close();
    }
  });
});
