import { describe, expect, it } from "vitest";
import {
  HOUR_DIVISORS,
  MINUTE_DIVISORS,
  type Preset,
  presetToCron,
  validatePreset,
} from "../../../src/components/schedules/cronPresets";

// Table-driven unit tests for the pure preset → cron mapping. The
// constraint is that every preset kind round-trips to the cron
// expression the CLI's `emploke schedule create --cron …` would
// accept; the server's `assertValidCronExpr` (cronstrue + croner)
// is the final arbiter on parseability, but these tests pin the
// surface-level mapping that the UI is responsible for.

describe("presetToCron", () => {
  const cases: { name: string; preset: Preset; expected: string }[] = [
    {
      name: "daily 09:30",
      preset: { kind: "daily", hour: 9, minute: 30 },
      expected: "30 9 * * *",
    },
    {
      name: "weekdays 09:00",
      preset: { kind: "weekdays", hour: 9, minute: 0 },
      expected: "0 9 * * 1-5",
    },
    {
      name: "weekly Mon/Wed/Fri 14:00",
      preset: { kind: "weekly", days: [1, 3, 5], hour: 14, minute: 0 },
      expected: "0 14 * * 1,3,5",
    },
    {
      name: "weekly day order is normalised (sorted ascending)",
      preset: { kind: "weekly", days: [5, 1, 3], hour: 14, minute: 0 },
      expected: "0 14 * * 1,3,5",
    },
    {
      name: "monthly day 15 at midnight",
      preset: { kind: "monthly", dayOfMonth: 15, hour: 0, minute: 0 },
      expected: "0 0 15 * *",
    },
    {
      name: "every 6 hours",
      preset: { kind: "every-n-hours", n: 6 },
      expected: "0 */6 * * *",
    },
    {
      name: "every 15 minutes",
      preset: { kind: "every-n-minutes", n: 15 },
      expected: "*/15 * * * *",
    },
    {
      name: "advanced expr is trimmed",
      preset: { kind: "advanced", expr: "  0 9 * * 1-5  " },
      expected: "0 9 * * 1-5",
    },
    {
      name: "advanced expr passes through complex syntax",
      preset: { kind: "advanced", expr: "*/5 9-17 * * 1-5" },
      expected: "*/5 9-17 * * 1-5",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(presetToCron(c.preset)).toBe(c.expected);
    });
  }

  it("Sunday-only weekly produces '0' as the day field (no negative offset)", () => {
    // 0 = Sunday per cron convention; verify we don't accidentally
    // remap to "7" (a non-standard alias some libs accept).
    expect(presetToCron({ kind: "weekly", days: [0], hour: 9, minute: 0 })).toBe("0 9 * * 0");
  });
});

describe("HOUR_DIVISORS and MINUTE_DIVISORS", () => {
  it("HOUR_DIVISORS contains only divisors of 24, excluding 24 itself", () => {
    for (const n of HOUR_DIVISORS) {
      expect(24 % n).toBe(0);
      expect(n).toBeLessThan(24);
      expect(n).toBeGreaterThan(0);
    }
  });

  it("MINUTE_DIVISORS contains only divisors of 60, excluding 60 itself", () => {
    for (const n of MINUTE_DIVISORS) {
      expect(60 % n).toBe(0);
      expect(n).toBeLessThan(60);
      expect(n).toBeGreaterThan(0);
    }
  });
});

describe("validatePreset", () => {
  it("returns null for a valid daily preset", () => {
    expect(validatePreset({ kind: "daily", hour: 9, minute: 0 })).toBeNull();
  });

  it("rejects weekly with no days selected", () => {
    expect(validatePreset({ kind: "weekly", days: [], hour: 9, minute: 0 })).toMatch(
      /at least one day/i,
    );
  });

  it("rejects monthly with dayOfMonth out of [1, 31]", () => {
    expect(validatePreset({ kind: "monthly", dayOfMonth: 32, hour: 9, minute: 0 })).toMatch(
      /day of month/i,
    );
  });

  it("rejects hour out of [0, 23]", () => {
    expect(validatePreset({ kind: "daily", hour: 24, minute: 0 })).toMatch(/hour/i);
  });

  it("rejects minute out of [0, 59]", () => {
    expect(validatePreset({ kind: "daily", hour: 9, minute: 60 })).toMatch(/minute/i);
  });

  it("rejects empty advanced expression", () => {
    expect(validatePreset({ kind: "advanced", expr: "   " })).toMatch(/empty/i);
  });

  it("accepts non-divisor every-n-hours at the pure-module layer (UX gate is in the form)", () => {
    // The form's `<select>` constrains to HOUR_DIVISORS, but the
    // pure mapping accepts any positive integer — this keeps the
    // tests easy to write and the module easy to reason about.
    expect(validatePreset({ kind: "every-n-hours", n: 7 })).toBeNull();
  });
});
