import { describe, expect, it } from "vitest";
import { InvalidCronExprError, InvalidScheduleIdError, ScheduleError } from "../src/errors.js";
import { ScheduleEntity } from "../src/schedule-entity.js";
import type { ScheduleRow } from "../src/schema.js";
import type { CreateScheduleArgs } from "../src/types.js";

const VALID_ID = "550e8400-e29b-41d4-a716-446655440000";
const FIXED_NOW = new Date("2026-05-01T00:00:00.000Z");

function baseArgs(over: Partial<CreateScheduleArgs> = {}): CreateScheduleArgs {
  return {
    name: "daily-report",
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: { kind: "task", agent: "report-bot", instructions: "Run the daily report" },
    ...over,
  };
}

describe("ScheduleEntity.create", () => {
  it("creates a valid entity", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    expect(e.id).toBe(VALID_ID);
    expect(e.name).toBe("daily-report");
    expect(e.trigger.kind).toBe("cron");
    expect(e.target.kind).toBe("task");
    expect(e.enabled).toBe(true);
    expect(e.createdAt).toBe(FIXED_NOW.toISOString());
    expect(e.updatedAt).toBe(FIXED_NOW.toISOString());
    expect(e.lastFiredAt).toBeUndefined();
    expect(e.nextFireAt).toBeUndefined();
  });

  it("respects enabled=false in args", () => {
    const e = ScheduleEntity.create(baseArgs({ enabled: false }), {
      id: VALID_ID,
      now: FIXED_NOW,
    });
    expect(e.enabled).toBe(false);
  });

  it("rejects bad id", () => {
    expect(() => ScheduleEntity.create(baseArgs(), { id: "not-a-uuid", now: FIXED_NOW })).toThrow(
      InvalidScheduleIdError,
    );
  });

  it("rejects empty name", () => {
    expect(() =>
      ScheduleEntity.create(baseArgs({ name: "" }), { id: VALID_ID, now: FIXED_NOW }),
    ).toThrow(ScheduleError);
    expect(() =>
      ScheduleEntity.create(baseArgs({ name: "   " }), { id: VALID_ID, now: FIXED_NOW }),
    ).toThrow(ScheduleError);
  });

  it("rejects malformed cron", () => {
    expect(() =>
      ScheduleEntity.create(baseArgs({ trigger: { kind: "cron", expr: "garbage", tz: "UTC" } }), {
        id: VALID_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(InvalidCronExprError);
  });

  it("rejects 6-field cron with the locked literal phrase", () => {
    try {
      ScheduleEntity.create(
        baseArgs({ trigger: { kind: "cron", expr: "*/5 * * * * *", tz: "UTC" } }),
        { id: VALID_ID, now: FIXED_NOW },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCronExprError);
      expect((err as Error).message).toContain("6-field cron not supported in v1");
    }
  });

  it("rejects bad timezone", () => {
    expect(() =>
      ScheduleEntity.create(
        baseArgs({ trigger: { kind: "cron", expr: "0 9 * * *", tz: "Not/A_Zone" } }),
        { id: VALID_ID, now: FIXED_NOW },
      ),
    ).toThrow();
  });

  it("rejects empty agent in task target", () => {
    expect(() =>
      ScheduleEntity.create(baseArgs({ target: { kind: "task", agent: "", instructions: "X" } }), {
        id: VALID_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ScheduleError);
  });

  it("rejects empty instructions in task target", () => {
    expect(() =>
      ScheduleEntity.create(
        baseArgs({ target: { kind: "task", agent: "report-bot", instructions: "" } }),
        { id: VALID_ID, now: FIXED_NOW },
      ),
    ).toThrow(ScheduleError);
  });
});

describe("ScheduleEntity.toRow / fromStored round-trip", () => {
  it("populates targetAgent only when target.kind === 'task'", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const row = e.toRow();
    expect(row.targetAgent).toBe("report-bot");
    expect(row.targetKind).toBe("task");
    expect(row.triggerKind).toBe("cron");
    expect(row.triggerExpr).toBe("0 9 * * *");
    expect(row.triggerTz).toBe("UTC");
    expect(row.enabled).toBe(true);
  });

  it("serialises target_json with agent + instructions + runtime", () => {
    const e = ScheduleEntity.create(
      baseArgs({
        target: {
          kind: "task",
          agent: "report-bot",
          instructions: "Hi",
          runtime: "copilot-cli",
        },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    const row = e.toRow();
    const parsed = JSON.parse(row.targetJson) as Record<string, unknown>;
    expect(parsed.kind).toBe("task");
    expect(parsed.agent).toBe("report-bot");
    expect(parsed.instructions).toBe("Hi");
    expect(parsed.runtime).toBe("copilot-cli");
  });

  it("round-trips through fromStored", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const row = e.toRow() as ScheduleRow;
    const hydrated = ScheduleEntity.fromStored(row);
    expect(hydrated.id).toBe(e.id);
    expect(hydrated.name).toBe(e.name);
    expect(hydrated.trigger).toEqual(e.trigger);
    expect(hydrated.target).toEqual(e.target);
    expect(hydrated.enabled).toBe(e.enabled);
    expect(hydrated.createdAt).toBe(e.createdAt);
    expect(hydrated.updatedAt).toBe(e.updatedAt);
  });
});

describe("ScheduleEntity.withPatched", () => {
  it("stamps updatedAt", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const later = new Date("2026-05-02T00:00:00.000Z");
    const p = e.withPatched({ name: "renamed" }, later);
    expect(p.name).toBe("renamed");
    expect(p.updatedAt).toBe(later.toISOString());
    expect(p.createdAt).toBe(FIXED_NOW.toISOString());
  });

  it("re-validates changed fields (rejects bad trigger)", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    expect(() =>
      e.withPatched({ trigger: { kind: "cron", expr: "garbage", tz: "UTC" } }, FIXED_NOW),
    ).toThrow(InvalidCronExprError);
  });

  it("does not re-validate untouched fields", () => {
    // Create with a valid trigger, then patch only `name`. If the
    // implementation re-validated the original trigger that'd be
    // fine but the test asserts no spurious side-effects.
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const p = e.withPatched({ name: "renamed" }, FIXED_NOW);
    expect(p.trigger).toEqual(e.trigger);
    expect(p.target).toEqual(e.target);
  });

  it("rejects bad target", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    expect(() =>
      e.withPatched({ target: { kind: "task", agent: "", instructions: "X" } }, FIXED_NOW),
    ).toThrow(ScheduleError);
  });
});

describe("ScheduleEntity.withNextFireAt / withFired", () => {
  it("withNextFireAt preserves lastFiredAt", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const fired = e.withFired("2026-05-01T09:00:00.000Z", "2026-05-02T09:00:00.000Z");
    const next = fired.withNextFireAt("2026-05-03T09:00:00.000Z");
    expect(next.lastFiredAt).toBe("2026-05-01T09:00:00.000Z");
    expect(next.nextFireAt).toBe("2026-05-03T09:00:00.000Z");
  });

  it("withFired stamps lastFiredAt + nextFireAt without touching updatedAt", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const fired = e.withFired("2026-05-01T09:00:00.000Z", "2026-05-02T09:00:00.000Z");
    expect(fired.lastFiredAt).toBe("2026-05-01T09:00:00.000Z");
    expect(fired.nextFireAt).toBe("2026-05-02T09:00:00.000Z");
    expect(fired.updatedAt).toBe(e.updatedAt);
  });
});

describe("ScheduleEntity.fromStored corruption guards", () => {
  function makeRow(over: Partial<ScheduleRow> = {}): ScheduleRow {
    const target = { kind: "task", agent: "report-bot", instructions: "Run" };
    return {
      id: VALID_ID,
      name: "daily-report",
      triggerKind: "cron",
      triggerExpr: "0 9 * * *",
      triggerTz: "UTC",
      targetKind: "task",
      targetJson: JSON.stringify(target),
      targetAgent: "report-bot",
      enabled: true,
      createdAt: FIXED_NOW.toISOString(),
      updatedAt: FIXED_NOW.toISOString(),
      lastFiredAt: null,
      nextFireAt: null,
      ...over,
    };
  }

  it("throws on unknown trigger_kind", () => {
    expect(() => ScheduleEntity.fromStored(makeRow({ triggerKind: "interval" }))).toThrow(
      ScheduleError,
    );
  });

  it("throws on unknown target_kind", () => {
    expect(() => ScheduleEntity.fromStored(makeRow({ targetKind: "workflow" }))).toThrow(
      ScheduleError,
    );
  });

  it("throws on target_json that is not valid JSON", () => {
    expect(() => ScheduleEntity.fromStored(makeRow({ targetJson: "not json" }))).toThrow(
      ScheduleError,
    );
  });

  it("throws when target_agent column does not match target_json.agent", () => {
    expect(() => ScheduleEntity.fromStored(makeRow({ targetAgent: "different-agent" }))).toThrow(
      ScheduleError,
    );
  });

  it("hydrates lastFiredAt + nextFireAt to undefined when row column is null", () => {
    const e = ScheduleEntity.fromStored(makeRow());
    expect(e.lastFiredAt).toBeUndefined();
    expect(e.nextFireAt).toBeUndefined();
  });
});
