import { describe, expect, it } from "vitest";
import { InvalidCronExprError, InvalidScheduleIdError, ScheduleError } from "../src/errors.js";
import { ScheduleEntity } from "../src/schedule-entity.js";
import type { ScheduleRow } from "../src/schema.js";
import type { CreateTaskScheduleArgs } from "../src/types.js";

const VALID_ID = "550e8400-e29b-41d4-a716-446655440000";
const FIXED_NOW = new Date("2026-05-01T00:00:00.000Z");

function baseArgs(over: Partial<CreateTaskScheduleArgs> = {}): CreateTaskScheduleArgs {
  return {
    name: "daily-report",
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: { agent: "report-bot", brief: "Run the daily report" },
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

  it("rejects empty agent in task target", () => {
    expect(() =>
      ScheduleEntity.create(baseArgs({ target: { agent: "", brief: "X" } }), {
        id: VALID_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ScheduleError);
  });

  it("rejects empty brief in task target", () => {
    expect(() =>
      ScheduleEntity.create(baseArgs({ target: { agent: "report-bot", brief: "" } }), {
        id: VALID_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ScheduleError);
  });

  it("rejects brief over 200 chars", () => {
    const longBrief = "x".repeat(201);
    expect(() =>
      ScheduleEntity.create(baseArgs({ target: { agent: "report-bot", brief: longBrief } }), {
        id: VALID_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ScheduleError);
  });

  it("rejects brief containing newline", () => {
    expect(() =>
      ScheduleEntity.create(baseArgs({ target: { agent: "report-bot", brief: "foo\nbar" } }), {
        id: VALID_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ScheduleError);
  });

  it("rejects brief containing carriage return", () => {
    expect(() =>
      ScheduleEntity.create(baseArgs({ target: { agent: "report-bot", brief: "foo\rbar" } }), {
        id: VALID_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ScheduleError);
  });

  it("accepts brief of exactly 200 chars (boundary)", () => {
    const boundary = "x".repeat(200);
    const e = ScheduleEntity.create(
      baseArgs({ target: { agent: "report-bot", brief: boundary } }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    expect((e.target as { brief: string }).brief.length).toBe(200);
  });

  it("accepts details as a string (including empty string — mirrors @emploke/task)", () => {
    const e = ScheduleEntity.create(
      baseArgs({ target: { agent: "report-bot", brief: "B", details: "" } }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    expect((e.target as { details?: string }).details).toBe("");
  });

  it("accepts details containing newlines (multi-line)", () => {
    const e = ScheduleEntity.create(
      baseArgs({
        target: { agent: "report-bot", brief: "B", details: "line 1\nline 2" },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    expect((e.target as { details?: string }).details).toBe("line 1\nline 2");
  });

  it("accepts target without details (optional, omitted)", () => {
    const e = ScheduleEntity.create(baseArgs({ target: { agent: "report-bot", brief: "B" } }), {
      id: VALID_ID,
      now: FIXED_NOW,
    });
    expect((e.target as { details?: string }).details).toBeUndefined();
  });

  it("rejects details of non-string type", () => {
    expect(() =>
      ScheduleEntity.create(
        baseArgs({
          target: {
            agent: "report-bot",
            brief: "B",
            details: 123 as unknown as string,
          },
        }),
        { id: VALID_ID, now: FIXED_NOW },
      ),
    ).toThrow(ScheduleError);
  });
});

describe("ScheduleEntity.toRow / fromStored round-trip", () => {
  it("serialises target_json with agent + brief", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    const row = e.toRow();
    expect(row.targetKind).toBe("task");
    expect(row.triggerKind).toBe("cron");
    expect(row.triggerExpr).toBe("0 9 * * *");
    expect(row.triggerTz).toBe("UTC");
    expect(row.enabled).toBe(true);
    // target_agent column is gone post-RFC #61 v2; toRow must not
    // emit it (drizzle would otherwise try to write to a missing
    // column and fail at runtime).
    expect(Object.hasOwn(row as object, "targetAgent")).toBe(false);
  });

  it("serialises target_json with agent + brief + details + runtime", () => {
    const e = ScheduleEntity.create(
      baseArgs({
        target: {
          agent: "report-bot",
          brief: "Hi",
          details: "Full body here.",
          runtime: "copilot-cli",
        },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    const row = e.toRow();
    const parsed = JSON.parse(row.targetJson) as Record<string, unknown>;
    expect(parsed.kind).toBe("task");
    expect(parsed.agent).toBe("report-bot");
    expect(parsed.brief).toBe("Hi");
    expect(parsed.details).toBe("Full body here.");
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

  it("round-trips empty-string details (mirrors @emploke/task contract)", () => {
    const e = ScheduleEntity.create(
      baseArgs({
        target: { agent: "report-bot", brief: "B", details: "" },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    const row = e.toRow() as ScheduleRow;
    const hydrated = ScheduleEntity.fromStored(row);
    expect((hydrated.target as { details?: string }).details).toBe("");
  });
});

describe("ScheduleEntity.withMetadata / withTrigger / withTaskTarget", () => {
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

  it("withTaskTarget(sparse) preserves siblings (regression for #226)", () => {
    const e = ScheduleEntity.create(
      baseArgs({
        target: {
          agent: "report-bot",
          brief: "Run the daily report",
          runtime: "node-22",
        },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    const p = e.withTaskTarget({ details: "added context" }, later);
    if (p.target.kind === "task") {
      expect(p.target.agent).toBe("report-bot");
      expect(p.target.brief).toBe("Run the daily report");
      expect(p.target.runtime).toBe("node-22");
      expect(p.target.details).toBe("added context");
    }
    expect(p.updatedAt).toBe(later.toISOString());
  });

  it("withTaskTarget(details: null) deletes details only (RFC 7396)", () => {
    const e = ScheduleEntity.create(
      baseArgs({
        target: {
          agent: "report-bot",
          brief: "B",
          details: "old",
          runtime: "node-22",
        },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    const p = e.withTaskTarget({ details: null }, later);
    if (p.target.kind === "task") {
      expect(p.target.details).toBeUndefined();
      expect(p.target.runtime).toBe("node-22");
    }
  });

  it("withTaskTarget(runtime: null) deletes runtime only (RFC 7396)", () => {
    const e = ScheduleEntity.create(
      baseArgs({
        target: { agent: "report-bot", brief: "B", details: "keep", runtime: "node-22" },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    const p = e.withTaskTarget({ runtime: null }, later);
    if (p.target.kind === "task") {
      expect(p.target.runtime).toBeUndefined();
      expect(p.target.details).toBe("keep");
    }
  });

  it("withTaskTarget(details: '') sets to empty string (distinct from delete)", () => {
    const e = ScheduleEntity.create(
      baseArgs({
        target: { agent: "report-bot", brief: "B", details: "old" },
      }),
      { id: VALID_ID, now: FIXED_NOW },
    );
    const p = e.withTaskTarget({ details: "" }, later);
    if (p.target.kind === "task") {
      expect(p.target.details).toBe("");
    }
  });

  it("withTaskTarget re-validates merged result (rejects empty-agent override)", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    expect(() => e.withTaskTarget({ agent: "" }, FIXED_NOW)).toThrow(ScheduleError);
  });

  it("withTaskTarget re-validates brief constraints on merged result", () => {
    const e = ScheduleEntity.create(baseArgs(), { id: VALID_ID, now: FIXED_NOW });
    expect(() => e.withTaskTarget({ brief: "foo\nbar" }, FIXED_NOW)).toThrow(ScheduleError);
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
    const target = { kind: "task", agent: "report-bot", brief: "Run" };
    return {
      id: VALID_ID,
      name: "daily-report",
      triggerKind: "cron",
      triggerExpr: "0 9 * * *",
      triggerTz: "UTC",
      targetKind: "task",
      targetJson: JSON.stringify(target),
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

  it("throws a remediation-bearing error on pre-v2 target_json with `instructions` but no `brief`", () => {
    // Fail-fast guard for local dev DBs created before RFC #61 v2.
    // The remediation hint MUST mention deleting the dev DB so the
    // symptom is obvious rather than leaking through as a cryptic
    // undefined-property error deep in the dispatch loop.
    const preV2Target = { kind: "task", agent: "report-bot", instructions: "Run" };
    let caught: unknown;
    try {
      ScheduleEntity.fromStored(makeRow({ targetJson: JSON.stringify(preV2Target) }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScheduleError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/pre-v2 target shape/);
    expect(msg).toMatch(/RFC #61 v2/);
    expect(msg).toMatch(/delete your local dev DB/);
  });

  it("throws when target_json.brief is missing (no instructions either)", () => {
    const noBrief = { kind: "task", agent: "report-bot" };
    expect(() =>
      ScheduleEntity.fromStored(makeRow({ targetJson: JSON.stringify(noBrief) })),
    ).toThrow(ScheduleError);
  });

  it("throws when target_json.details is non-string", () => {
    const badDetails = { kind: "task", agent: "report-bot", brief: "B", details: 7 };
    expect(() =>
      ScheduleEntity.fromStored(makeRow({ targetJson: JSON.stringify(badDetails) })),
    ).toThrow(ScheduleError);
  });

  it("hydrates lastFiredAt + nextFireAt to undefined when row column is null", () => {
    const e = ScheduleEntity.fromStored(makeRow());
    expect(e.lastFiredAt).toBeUndefined();
    expect(e.nextFireAt).toBeUndefined();
  });
});
