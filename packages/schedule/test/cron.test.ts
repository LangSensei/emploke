import { describe, expect, it } from "vitest";
import { assertValidCronExpr, assertValidTimezone, describeCron, nextRuns } from "../src/cron.js";
import { InvalidCronExprError, InvalidTimezoneError } from "../src/errors.js";

describe("cron.assertValidCronExpr", () => {
  it("accepts a standard 5-field expression", () => {
    expect(() => assertValidCronExpr("*/5 * * * *")).not.toThrow();
    expect(() => assertValidCronExpr("0 9 * * 1-5")).not.toThrow();
    expect(() => assertValidCronExpr("0 0 1 1 *")).not.toThrow();
  });

  it("rejects 6-field expressions with the locked literal phrase", () => {
    try {
      assertValidCronExpr("*/5 * * * * *");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCronExprError);
      const e = err as InvalidCronExprError;
      expect(e.message).toContain("6-field cron not supported in v1");
    }
  });

  it("rejects garbage", () => {
    expect(() => assertValidCronExpr("not a cron")).toThrow(InvalidCronExprError);
    expect(() => assertValidCronExpr("")).toThrow(InvalidCronExprError);
    expect(() => assertValidCronExpr("* * * *")).toThrow(InvalidCronExprError);
  });

  it("rejects 4-field as not 5-field (covered by FIVE_FIELD_RE)", () => {
    expect(() => assertValidCronExpr("* * * *")).toThrow(InvalidCronExprError);
  });
});

describe("cron.assertValidTimezone", () => {
  it("accepts UTC", () => {
    expect(() => assertValidTimezone("UTC")).not.toThrow();
  });

  it("accepts named IANA zones", () => {
    expect(() => assertValidTimezone("Asia/Shanghai")).not.toThrow();
    expect(() => assertValidTimezone("America/New_York")).not.toThrow();
    expect(() => assertValidTimezone("Europe/London")).not.toThrow();
  });

  it("rejects unknown zones", () => {
    expect(() => assertValidTimezone("Not/A_Zone")).toThrow(InvalidTimezoneError);
  });
});

describe("cron.nextRuns", () => {
  it("returns n ISO timestamps in ascending order", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    const runs = nextRuns("0 * * * *", "UTC", after, 3);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toBe("2026-01-01T01:00:00.000Z");
    expect(runs[1]).toBe("2026-01-01T02:00:00.000Z");
    expect(runs[2]).toBe("2026-01-01T03:00:00.000Z");
  });

  it("advances the cursor on each iteration (no duplicate first fire)", () => {
    const after = new Date("2026-01-01T00:00:00Z");
    const runs = nextRuns("0 9 * * *", "UTC", after, 3);
    expect(new Set(runs).size).toBe(3);
  });

  it("honours the timezone when computing the UTC instant", () => {
    // "every day at 09:00 Tokyo" = 00:00 UTC
    const after = new Date("2026-01-01T01:00:00Z");
    const [first] = nextRuns("0 9 * * *", "Asia/Tokyo", after, 1);
    expect(first).toBe("2026-01-02T00:00:00.000Z");
  });

  it("returns fewer results if cron is exhausted (defensive; shouldn't happen for standard exprs)", () => {
    const after = new Date("2030-01-01T00:00:00Z");
    const runs = nextRuns("0 0 * * *", "UTC", after, 5);
    expect(runs.length).toBeGreaterThan(0);
  });
});

describe("cron.describeCron", () => {
  it("returns a non-empty English description for a valid cron (issue #224)", () => {
    const text = describeCron("0 9 * * *");
    expect(text.length).toBeGreaterThan(0);
    // English output must not leak the previously-hardcoded zh_CN locale.
    expect(/[\u4e00-\u9fa5]/.test(text)).toBe(false);
    expect(text.toLowerCase()).toContain("at 09:00");
  });
});
