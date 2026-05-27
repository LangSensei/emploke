import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidCronExprError, InvalidTimezoneError, ScheduleError } from "../src/errors.js";
import { makeScheduleTestHandle, type ScheduleTestHandle } from "./_helpers.js";

describe("ScheduleService.preview", () => {
  let h: ScheduleTestHandle;

  beforeEach(() => {
    h = makeScheduleTestHandle({ initialNow: new Date("2026-05-01T00:00:00.000Z") });
  });

  afterEach(async () => {
    await h.service.shutdown();
    h.close();
  });

  it("returns 3 ISO timestamps in ascending order (default n)", async () => {
    const result = await h.service.preview("0 9 * * *", "UTC");
    expect(result.nextRuns).toHaveLength(3);
    expect(result.nextRuns[0]).toBe("2026-05-01T09:00:00.000Z");
    expect(result.nextRuns[1]).toBe("2026-05-02T09:00:00.000Z");
    expect(result.nextRuns[2]).toBe("2026-05-03T09:00:00.000Z");
  });

  it("returns a non-empty Chinese describe", async () => {
    const result = await h.service.preview("0 9 * * *", "UTC");
    expect(result.describe.length).toBeGreaterThan(0);
    expect(/[\u4e00-\u9fa5]/.test(result.describe)).toBe(true);
  });

  it("honours an explicit n=1", async () => {
    const result = await h.service.preview("0 9 * * *", "UTC", 1);
    expect(result.nextRuns).toHaveLength(1);
    expect(result.nextRuns[0]).toBe("2026-05-01T09:00:00.000Z");
  });

  it("honours an explicit n=10", async () => {
    const result = await h.service.preview("0 9 * * *", "UTC", 10);
    expect(result.nextRuns).toHaveLength(10);
    expect(result.nextRuns[0]).toBe("2026-05-01T09:00:00.000Z");
    expect(result.nextRuns[9]).toBe("2026-05-10T09:00:00.000Z");
  });

  it("rejects n=0 with ScheduleError", async () => {
    await expect(h.service.preview("0 9 * * *", "UTC", 0)).rejects.toBeInstanceOf(ScheduleError);
  });

  it("rejects n above upper bound (101) with ScheduleError", async () => {
    await expect(h.service.preview("0 9 * * *", "UTC", 101)).rejects.toBeInstanceOf(ScheduleError);
  });

  it("rejects non-integer n with ScheduleError", async () => {
    await expect(h.service.preview("0 9 * * *", "UTC", 2.5)).rejects.toBeInstanceOf(ScheduleError);
  });

  it("rejects 6-field cron with the locked literal phrase", async () => {
    try {
      await h.service.preview("*/5 * * * * *", "UTC");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCronExprError);
      expect((err as Error).message).toContain("6-field cron not supported in v1");
    }
  });

  it("rejects unknown timezone", async () => {
    await expect(h.service.preview("0 9 * * *", "Not/A_Zone")).rejects.toThrow(
      InvalidTimezoneError,
    );
  });
});
