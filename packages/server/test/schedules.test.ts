/**
 * Route-level tests for `routes/schedules.ts`. Sibling of
 * `scheduled-tasks.test.ts` — same stub pattern, same vitest layout.
 *
 * The route owns 7 verbs (list, create, get, patch, delete, run,
 * preview); the assertion surface covers:
 *
 *   - happy-path passthrough to the injected ScheduleService stub
 *   - input validation 400s (enabled flag, n bounds, body shape)
 *   - 404 mapping for ScheduleNotFoundError (incl. the null branch of
 *     get(sid) for the GET /:sid route)
 *   - 409 mapping for ScheduleEnabledError / ScheduleHasInFlightError
 *   - 400 mapping for InvalidCronExprError / InvalidTimezoneError
 *   - preview slicing behaviour when n < service's fixed 3
 *   - response envelope (`code` is always present for typed errors)
 */

import {
  InvalidCronExprError,
  InvalidScheduleIdError,
  InvalidTimezoneError,
  type PreviewResult,
  type Schedule,
  ScheduleEnabledError,
  ScheduleHasInFlightError,
  ScheduleNotFoundError,
  type ScheduleService,
} from "@emploke/schedule";
import { describe, expect, it, vi } from "vitest";
import { schedulesRoutes } from "../src/routes/schedules.js";

const sampleSchedule: Schedule = {
  id: "sched-abc",
  name: "Weekday morning summary",
  target: {
    kind: "task",
    agent: "writer",
    instructions: "Summarise yesterday's commits",
  },
  trigger: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Shanghai" },
  enabled: true,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function stubService(overrides: Partial<Record<keyof ScheduleService, unknown>>): ScheduleService {
  const stub: Partial<Record<keyof ScheduleService, unknown>> = {
    list: vi.fn(async () => [sampleSchedule]),
    create: vi.fn(async () => sampleSchedule),
    get: vi.fn(async () => sampleSchedule),
    patch: vi.fn(async () => sampleSchedule),
    delete: vi.fn(async () => undefined),
    run: vi.fn(async () => ({ taskId: "task-001" })),
    preview: vi.fn(
      async (): Promise<PreviewResult> => ({
        describe: "在周一至周五的 09:00",
        nextRuns: [
          "2026-06-01T01:00:00.000Z",
          "2026-06-02T01:00:00.000Z",
          "2026-06-03T01:00:00.000Z",
        ],
      }),
    ),
    ...overrides,
  };
  return stub as unknown as ScheduleService;
}

describe("schedulesRoutes — list", () => {
  it("GET / returns the schedule list", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([sampleSchedule]);
    expect(svc.list).toHaveBeenCalledWith({});
  });

  it("GET /?agent=x&enabled=true forwards both filters", async () => {
    const list = vi.fn(async () => []);
    const svc = stubService({ list });
    const res = await schedulesRoutes(() => svc).request("/?agent=writer&enabled=true");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ agent: "writer", enabled: true });
  });

  it("GET /?enabled=bogus returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/?enabled=bogus");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/"true" or "false"/);
    expect(svc.list).not.toHaveBeenCalled();
  });
});

describe("schedulesRoutes — create", () => {
  it("POST / creates and returns 201", async () => {
    const create = vi.fn(async () => sampleSchedule);
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Weekday morning summary",
        target: sampleSchedule.target,
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(sampleSchedule);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("POST / with missing name returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: sampleSchedule.target,
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name/);
  });

  it("POST / with malformed target returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { kind: "workflow" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/target/);
  });

  it("POST / with invalid cron expr maps to 400 with typed code", async () => {
    const create = vi.fn(async () => {
      throw new InvalidCronExprError("bogus", "not a cron");
    });
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: sampleSchedule.target,
        trigger: { kind: "cron", expr: "bogus", tz: "UTC" },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("InvalidCronExprError");
  });

  it("POST / with invalid timezone maps to 400 with typed code", async () => {
    const create = vi.fn(async () => {
      throw new InvalidTimezoneError("Mars/Olympus");
    });
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: sampleSchedule.target,
        trigger: { kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("InvalidTimezoneError");
  });
});

describe("schedulesRoutes — get", () => {
  it("GET /:sid returns the schedule", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc");
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(sampleSchedule.id);
    expect(svc.get).toHaveBeenCalledWith("sched-abc");
  });

  it("GET /:sid → 404 when service returns null", async () => {
    const get = vi.fn(async () => null);
    const svc = stubService({ get });
    const res = await schedulesRoutes(() => svc).request("/missing");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("ScheduleNotFoundError");
  });

  it("GET /:sid → 400 on InvalidScheduleIdError", async () => {
    const get = vi.fn(async () => {
      throw new InvalidScheduleIdError("bad");
    });
    const svc = stubService({ get });
    const res = await schedulesRoutes(() => svc).request("/bad");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("InvalidScheduleIdError");
  });
});

describe("schedulesRoutes — patch", () => {
  it("PATCH /:sid forwards the partial body", async () => {
    const patch = vi.fn(async () => sampleSchedule);
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(patch).toHaveBeenCalledWith("sched-abc", { enabled: false });
  });

  it("PATCH /:sid maps ScheduleNotFoundError → 404", async () => {
    const patch = vi.fn(async () => {
      throw new ScheduleNotFoundError("x");
    });
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("schedulesRoutes — delete", () => {
  it("DELETE /:sid returns { ok: true }", async () => {
    const del = vi.fn(async () => undefined);
    const svc = stubService({ delete: del });
    const res = await schedulesRoutes(() => svc).request("/sched-abc", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(del).toHaveBeenCalledWith("sched-abc");
  });

  it("DELETE /:sid maps ScheduleEnabledError → 409", async () => {
    const del = vi.fn(async () => {
      throw new ScheduleEnabledError("sched-abc");
    });
    const svc = stubService({ delete: del });
    const res = await schedulesRoutes(() => svc).request("/sched-abc", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ScheduleEnabledError");
  });

  it("DELETE /:sid maps ScheduleHasInFlightError → 409", async () => {
    const del = vi.fn(async () => {
      throw new ScheduleHasInFlightError("sched-abc");
    });
    const svc = stubService({ delete: del });
    const res = await schedulesRoutes(() => svc).request("/sched-abc", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ScheduleHasInFlightError");
  });
});

describe("schedulesRoutes — run", () => {
  it("POST /:sid/run returns { taskId }", async () => {
    const run = vi.fn(async () => ({ taskId: "task-fresh" }));
    const svc = stubService({ run });
    const res = await schedulesRoutes(() => svc).request("/sched-abc/run", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ taskId: "task-fresh" });
    expect(run).toHaveBeenCalledWith("sched-abc");
  });

  it("POST /:sid/run on missing schedule → 404", async () => {
    const run = vi.fn(async () => {
      throw new ScheduleNotFoundError("ghost");
    });
    const svc = stubService({ run });
    const res = await schedulesRoutes(() => svc).request("/ghost/run", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("schedulesRoutes — preview", () => {
  it("GET /:sid/preview returns the cron description + nextRuns", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc/preview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.describe).toMatch(/09:00|周一/);
    expect(body.nextRuns).toHaveLength(3);
  });

  it("GET /:sid/preview?n=1 slices to 1 entry", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc/preview?n=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextRuns).toHaveLength(1);
  });

  it("GET /:sid/preview?n=0 returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc/preview?n=0");
    expect(res.status).toBe(400);
  });

  it("GET /:sid/preview?n=999 returns 400 (over upper bound)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc/preview?n=999");
    expect(res.status).toBe(400);
  });

  it("GET /:sid/preview on missing schedule → 404", async () => {
    const get = vi.fn(async () => null);
    const svc = stubService({ get });
    const res = await schedulesRoutes(() => svc).request("/missing/preview");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("ScheduleNotFoundError");
  });
});
