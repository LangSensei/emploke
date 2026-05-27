import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InvalidScheduleIdError } from "../src/errors.js";
import { assertValidScheduleId, generateScheduleId } from "../src/validate.js";

describe("validate.assertValidScheduleId", () => {
  it("accepts a real UUID v4", () => {
    const id = randomUUID();
    expect(() => assertValidScheduleId(id)).not.toThrow();
  });

  it("accepts known UUID v4 literals", () => {
    expect(() => assertValidScheduleId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  it("rejects YYYYMMDD-xxxxxxxx form (used by task/session/workflow)", () => {
    expect(() => assertValidScheduleId("20260101-deadbeef")).toThrow(InvalidScheduleIdError);
  });

  it("rejects empty / non-string / arbitrary strings", () => {
    expect(() => assertValidScheduleId("")).toThrow(InvalidScheduleIdError);
    expect(() => assertValidScheduleId("abc")).toThrow(InvalidScheduleIdError);
    expect(() => assertValidScheduleId(undefined)).toThrow(InvalidScheduleIdError);
    expect(() => assertValidScheduleId(123)).toThrow(InvalidScheduleIdError);
  });

  it("rejects UUID v1 (version digit != 4)", () => {
    // version 1 has "1xxx" in the third segment
    expect(() => assertValidScheduleId("550e8400-e29b-11d4-a716-446655440000")).toThrow(
      InvalidScheduleIdError,
    );
  });
});

describe("validate.generateScheduleId", () => {
  it("uses node:crypto by default", () => {
    const id = generateScheduleId();
    expect(() => assertValidScheduleId(id)).not.toThrow();
  });

  it("honours the injected randomUUIDFn (deterministic-test seam)", () => {
    const fixed = "550e8400-e29b-41d4-a716-446655440000";
    const id = generateScheduleId(() => fixed);
    expect(id).toBe(fixed);
  });
});
