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
    target: { kind: "task", data: { agent: "report-bot", brief: "Run the daily report" } },
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
    expect(e.target.data).toEqual({ agent: "report-bot", brief: "Run the daily report" });
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
      expect(err instanceof Error ? err.message : String(err)).toContain(
        "6-field cron not supported in v1",
      );
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

  it("stores target.data opaquely without inspecting it (handler owns shape)", () => {
    // The entity is kind-agnostic: it does NOT validate the data
    // payload (the handler's validate is called by the service
    // BEFORE constructing the entity). Smoke-test: a "task" envelope
    // with a malformed payload still round-trips at the entity layer.
    // Real shape rejection happens in the task handler tests.
    const e = ScheduleEntity.create(
      baseArgs({
        target: { kind: "task", data: { agent: "", brief: "" } },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    expect(e.target.kind).toBe("task");
    expect(e.target.data).toEqual({ agent: "", brief: "" });
  });
});

describe("ScheduleEntity.toRow / fromStored round-trip", () => {
  it("toRow stores target_json as the DATA payload only (not the full envelope)", () => {
    // Regression guard: serialising the full envelope into target_json
    // would double-encode `kind` (it already lives in target_kind)
    // and let the column disagree with the JSON.
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const row = e.toRow();
    expect(row.targetKind).toBe("task");
    expect(row.targetJson).toBe(
      JSON.stringify({ agent: "report-bot", brief: "Run the daily report" }),
    );
    // Explicit reverse assertion — parsed JSON must NOT carry `kind`.
    const parsed = JSON.parse(row.targetJson) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "kind")).toBe(false);
    expect(parsed.agent).toBe("report-bot");
    expect(parsed.brief).toBe("Run the daily report");
  });

  it("toRow with details + runtime serialises them inside target_json", () => {
    const e = ScheduleEntity.create(
      baseArgs({
        target: {
          kind: "task",
          data: {
            agent: "report-bot",
            brief: "Hi",
            details: "Full body here.",
            runtime: "copilot-cli",
          },
        },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    const row = e.toRow();
    const parsed = JSON.parse(row.targetJson) as Record<string, unknown>;
    expect(parsed.agent).toBe("report-bot");
    expect(parsed.brief).toBe("Hi");
    expect(parsed.details).toBe("Full body here.");
    expect(parsed.runtime).toBe("copilot-cli");
  });

  it("round-trips through fromStored losslessly (kind in column, data in JSON)", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const row = e.toRow() as ScheduleRow;
    const hydrated = ScheduleEntity.fromStored(row);
    expect(hydrated.id).toBe(e.id);
    expect(hydrated.name).toBe(e.name);
    expect(hydrated.trigger).toEqual(e.trigger);
    expect(hydrated.target.kind).toBe(e.target.kind);
    expect(hydrated.target.data).toEqual(e.target.data);
    expect(hydrated.enabled).toBe(e.enabled);
    expect(hydrated.createdAt).toBe(e.createdAt);
    expect(hydrated.updatedAt).toBe(e.updatedAt);
  });

  it("round-trips an arbitrary opaque payload (substrate is kind-agnostic)", () => {
    const e = ScheduleEntity.create(
      baseArgs({
        target: {
          kind: "task",
          data: { nested: { deeply: ["arbitrary", "shape"] }, flag: true, n: 42 },
        },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    const row = e.toRow() as ScheduleRow;
    const hydrated = ScheduleEntity.fromStored(row);
    expect(hydrated.target.data).toEqual({
      nested: { deeply: ["arbitrary", "shape"] },
      flag: true,
      n: 42,
    });
  });
});

describe("ScheduleEntity.withMetadata / withTrigger / withTarget", () => {
  const later = new Date("2026-05-02T00:00:00.000Z");

  it("withMetadata sets name and stamps updatedAt", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const p = e.withMetadata({ name: "renamed" }, later);
    expect(p.name).toBe("renamed");
    expect(p.updatedAt).toBe(later.toISOString());
    expect(p.createdAt).toBe(FIXED_NOW.toISOString());
    expect(p.enabled).toBe(e.enabled);
    expect(p.trigger).toEqual(e.trigger);
    expect(p.target).toEqual(e.target);
  });

  it("withMetadata sets enabled independently of name", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const p = e.withMetadata({ enabled: false }, later);
    expect(p.enabled).toBe(false);
    expect(p.name).toBe(e.name);
  });

  it("withMetadata rejects empty name", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    expect(() => e.withMetadata({ name: "" }, later)).toThrow(ScheduleError);
  });

  it("withTrigger replaces wholesale and stamps updatedAt", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const p = e.withTrigger({ kind: "cron", expr: "0 10 * * *", tz: "UTC" }, later);
    expect(p.trigger.expr).toBe("0 10 * * *");
    expect(p.updatedAt).toBe(later.toISOString());
    expect(p.target).toEqual(e.target);
  });

  it("withTrigger rejects bad cron expr", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    expect(() => e.withTrigger({ kind: "cron", expr: "garbage", tz: "UTC" }, FIXED_NOW)).toThrow(
      InvalidCronExprError,
    );
  });

  it("withTarget replaces the envelope wholesale and stamps updatedAt", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const p = e.withTarget(
      { kind: "task", data: { agent: "other-bot", brief: "different" } },
      later,
    );
    expect(p.target.kind).toBe("task");
    expect(p.target.data).toEqual({ agent: "other-bot", brief: "different" });
    expect(p.updatedAt).toBe(later.toISOString());
  });

  it("withTarget refuses to change the kind on an existing row", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    expect(() => e.withTarget({ kind: "workflow", data: { wfId: "wf-1" } }, later)).toThrow(
      ScheduleError,
    );
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
    const data = { agent: "report-bot", brief: "Run" };
    return {
      id: VALID_ID,
      name: "daily-report",
      triggerKind: "cron",
      triggerExpr: "0 9 * * *",
      triggerTz: "UTC",
      targetKind: "task",
      targetJson: JSON.stringify(data),
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

  it("accepts arbitrary target_kind on read (substrate is kind-blind; preflight is the gate)", () => {
    // The entity layer trusts persisted data — `recover()`'s
    // preflight is the single point that catches "no handler for
    // this kind". `fromStored` happily produces an envelope for any
    // string kind because the caller (the service) routes through
    // `handlerFor` before using `data`.
    const e = ScheduleEntity.fromStored(makeRow({ targetKind: "workflow" }));
    expect(e.target.kind).toBe("workflow");
  });

  it("throws on target_json that is not valid JSON", () => {
    expect(() => ScheduleEntity.fromStored(makeRow({ targetJson: "not json" }))).toThrow(
      ScheduleError,
    );
  });

  it("hydrates lastFiredAt + nextFireAt to undefined when row column is null", () => {
    const e = ScheduleEntity.fromStored(makeRow());
    expect(e.lastFiredAt).toBeUndefined();
    expect(e.nextFireAt).toBeUndefined();
  });
});
