import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ScheduleError,
  ScheduleKindAlreadyRegisteredError,
  ScheduleKindNotRegisteredError,
} from "../src/errors.js";
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

describe("ScheduleService — open kind registry", () => {
  let db: ReturnType<typeof openTestScheduleDb>;
  let repo: ScheduleRepository;
  let service: ScheduleService;

  beforeEach(() => {
    db = openTestScheduleDb();
    repo = new ScheduleRepository({ db: db.db });
    service = new ScheduleService({
      repo,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
      randomUUID: fixedRandomUUID(VALID_UUIDS),
    });
  });

  afterEach(async () => {
    await service.shutdown();
    db.close();
  });

  it("registerKind throws ScheduleKindAlreadyRegisteredError on duplicate", () => {
    service.registerKind("task", makeStubHandler());
    expect(() => service.registerKind("task", makeStubHandler())).toThrow(
      ScheduleKindAlreadyRegisteredError,
    );
  });

  it.each([
    "", // empty
    "   ", // whitespace
    "Task", // uppercase
    "1task", // leading digit
    "task!", // special char
    "task name", // space
  ])("registerKind rejects invalid kind name %j", (badKind) => {
    expect(() => service.registerKind(badKind, makeStubHandler())).toThrow(ScheduleError);
  });

  it("registerKind accepts valid kind names (a..z, 0..9, _, -)", () => {
    expect(() => service.registerKind("task", makeStubHandler())).not.toThrow();
    expect(() => service.registerKind("workflow_v2", makeStubHandler())).not.toThrow();
    expect(() => service.registerKind("webhook-fanout", makeStubHandler())).not.toThrow();
  });

  it("create with an unregistered kind throws ScheduleKindNotRegisteredError", async () => {
    service.registerKind("task", makeStubHandler());
    await expect(
      service.create({
        ...baseArgs(),
        target: { kind: "unregistered", data: {} },
      }),
    ).rejects.toBeInstanceOf(ScheduleKindNotRegisteredError);
  });

  it("two kinds coexist without cross-contamination", async () => {
    const taskH = makeStubHandler();
    const noopH = makeStubHandler();
    service.registerKind("task", taskH);
    service.registerKind("noop", noopH);

    // Create + run a task-kind schedule.
    const s1 = await service.create({
      name: "task-sched",
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      target: { kind: "task", data: { agent: "report-bot", brief: "X" } },
      enabled: false,
    });
    await service.run(s1.id);

    // Create + run a noop-kind schedule.
    const s2 = await service.create({
      name: "noop-sched",
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      target: { kind: "noop", data: { msg: "ping" } },
      enabled: false,
    });
    await service.run(s2.id);

    // Each handler only saw its own kind's dispatches.
    expect(taskH.dispatchCalls).toHaveLength(1);
    expect(taskH.dispatchCalls[0]?.data).toEqual({ agent: "report-bot", brief: "X" });
    expect(noopH.dispatchCalls).toHaveLength(1);
    expect(noopH.dispatchCalls[0]?.data).toEqual({ msg: "ping" });
  });
});
