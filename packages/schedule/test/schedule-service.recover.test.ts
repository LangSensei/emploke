import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleEntity } from "../src/schedule-entity.js";
import { ScheduleRepository } from "../src/schedule-repository.js";
import { ScheduleService } from "../src/schedule-service.js";
import { openTestScheduleDb } from "../src/testing.js";
import type { CreateScheduleArgs } from "../src/types.js";
import { acceptAgent, fixedRandomUUID, makeStubDispatcher, VALID_UUIDS } from "./_helpers.js";

function baseArgs(over: Partial<CreateScheduleArgs> = {}): CreateScheduleArgs {
  return {
    name: "daily-report",
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: { kind: "task", agent: "report-bot", instructions: "Run the daily report" },
    ...over,
  };
}

describe("ScheduleService.recover", () => {
  let db: ReturnType<typeof openTestScheduleDb>;
  let repo: ScheduleRepository;
  let dispatcher: ReturnType<typeof makeStubDispatcher>;
  let service: ScheduleService;
  let nowRef: { value: Date };

  beforeEach(() => {
    vi.useFakeTimers();
    db = openTestScheduleDb();
    repo = new ScheduleRepository({ db: db.db });
    dispatcher = makeStubDispatcher();
    nowRef = { value: new Date("2026-05-02T00:00:00.000Z") };
    service = new ScheduleService({
      repo,
      taskDispatcher: dispatcher,
      agentValidator: acceptAgent,
      now: () => nowRef.value,
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
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

    expect(dispatcher.calls).toHaveLength(1);
    const call = dispatcher.calls[0]!;
    // firedAt is the PLANNED past time, not `now`.
    expect(call.metadata.firedAt).toBe(plannedFireIso);
    expect(call.metadata.scheduleId).toBe(VALID_UUIDS[0]);
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

    expect(dispatcher.calls).toHaveLength(1);
  });

  it("arms timer (no dispatch) for an enabled schedule with FUTURE next_fire_at", async () => {
    const entity = ScheduleEntity.create(baseArgs(), {
      id: VALID_UUIDS[0],
      now: nowRef.value,
    }).withNextFireAt("2026-05-02T09:00:00.000Z");
    await repo.insert(entity);

    await service.recover();
    expect(dispatcher.calls).toHaveLength(0);

    // Advance to the scheduled time — the armed timer should fire.
    nowRef.value = new Date("2026-05-02T09:00:00.000Z");
    await vi.advanceTimersByTimeAsync(10 * 60 * 60_000);
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("skips disabled schedules entirely", async () => {
    const entity = ScheduleEntity.create(baseArgs({ enabled: false }), {
      id: VALID_UUIDS[0],
      now: new Date("2026-05-01T00:00:00.000Z"),
    }).withFired("2026-05-01T09:00:00.000Z", "2026-05-01T18:00:00.000Z");
    await repo.insert(entity);

    await service.recover();
    expect(dispatcher.calls).toHaveLength(0);
    // last_fired_at / next_fire_at must not be rewritten.
    const after = await service.get(VALID_UUIDS[0]);
    expect(after?.lastFiredAt).toBe("2026-05-01T09:00:00.000Z");
    expect(after?.nextFireAt).toBe("2026-05-01T18:00:00.000Z");
  });

  it("recover after shutdown is a no-op for canceled timers", async () => {
    const entity = ScheduleEntity.create(baseArgs(), {
      id: VALID_UUIDS[0],
      now: nowRef.value,
    }).withNextFireAt("2026-05-02T09:00:00.000Z");
    await repo.insert(entity);

    await service.recover();
    await service.shutdown();

    // Advance the clock past the fire — no dispatch should happen.
    nowRef.value = new Date("2026-05-02T10:00:00.000Z");
    await vi.advanceTimersByTimeAsync(20 * 60 * 60_000);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("recover can be re-called after shutdown to re-arm timers", async () => {
    const entity = ScheduleEntity.create(baseArgs(), {
      id: VALID_UUIDS[0],
      now: nowRef.value,
    }).withNextFireAt("2026-05-02T09:00:00.000Z");
    await repo.insert(entity);

    await service.recover();
    await service.shutdown();
    await service.recover();

    nowRef.value = new Date("2026-05-02T09:00:00.000Z");
    await vi.advanceTimersByTimeAsync(10 * 60 * 60_000);
    expect(dispatcher.calls).toHaveLength(1);
  });
});
