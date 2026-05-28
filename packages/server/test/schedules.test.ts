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
    brief: "Summarise yesterday's commits",
    details: "Pull yesterday's commit log and produce a short digest grouped by author.",
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
    // Stub mirrors the real service's contract: returns exactly `n`
    // entries (default 3) so the route-layer tests that exercise
    // `?n=10` see the count plumbed through.
    preview: vi.fn(
      async (_expr: string, _tz: string, n = 3): Promise<PreviewResult> => ({
        describe: "在周一至周五的 09:00",
        nextRuns: Array.from(
          { length: n },
          (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}T01:00:00.000Z`,
        ),
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

  it("POST / with missing target.brief returns 400 (route-layer rejection)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { kind: "task", agent: "writer" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/brief/);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("POST / with target.brief over 200 chars returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { kind: "task", agent: "writer", brief: "x".repeat(201) },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/200/);
  });

  it("POST / with target.brief containing newline returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { kind: "task", agent: "writer", brief: "foo\nbar" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/single line/);
  });

  it("POST / with target.brief containing carriage return returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { kind: "task", agent: "writer", brief: "foo\rbar" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/single line/);
  });

  it("POST / with target.details set to empty string returns 201 (mirrors @emploke/task)", async () => {
    const create = vi.fn(async () => sampleSchedule);
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { kind: "task", agent: "writer", brief: "ok", details: "" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("POST / with target.details set to a non-string returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { kind: "task", agent: "writer", brief: "ok", details: 7 },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/details/);
  });

  it("POST / with target.details omitted returns 201", async () => {
    const create = vi.fn(async () => sampleSchedule);
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { kind: "task", agent: "writer", brief: "ok" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
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
  it("GET /:sid returns the schedule enriched with describe", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(sampleSchedule.id);
    // `describe` is computed by the route from `trigger.expr` (cronstrue,
    // zh_CN locale). The exact string isn't snapshotted — we just
    // assert the field is present and non-empty so the route stays
    // wired to `describeCron` even if cronstrue's wording shifts.
    expect(typeof body.describe).toBe("string");
    expect(body.describe.length).toBeGreaterThan(0);
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

  it("PATCH /:sid with a non-JSON body returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/JSON/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /:sid maps ScheduleNotFoundError → 404 with typed code", async () => {
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
    expect((await res.json()).code).toBe("ScheduleNotFoundError");
  });

  it("PATCH /:sid maps InvalidCronExprError → 400 with typed code", async () => {
    const patch = vi.fn(async () => {
      throw new InvalidCronExprError("bogus", "not a cron");
    });
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: { kind: "cron", expr: "bogus", tz: "UTC" } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("InvalidCronExprError");
  });

  it("PATCH /:sid with target.brief over 200 chars returns 400 (route-layer rejection)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { kind: "task", agent: "writer", brief: "x".repeat(201) },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/200/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /:sid with target.brief containing newline returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { kind: "task", agent: "writer", brief: "foo\nbar" },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/single line/);
  });

  it("PATCH /:sid with target.details non-string returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { kind: "task", agent: "writer", brief: "ok", details: 7 },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/details/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /:sid with target.details empty string is forwarded (mirrors @emploke/task)", async () => {
    const patch = vi.fn(async () => sampleSchedule);
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { kind: "task", agent: "writer", brief: "ok", details: "" },
      }),
    });
    expect(res.status).toBe(200);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("sched-abc", {
      target: { kind: "task", agent: "writer", brief: "ok", details: "" },
    });
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

  it("POST /:sid/run on missing schedule → 404 with typed code", async () => {
    const run = vi.fn(async () => {
      throw new ScheduleNotFoundError("ghost");
    });
    const svc = stubService({ run });
    const res = await schedulesRoutes(() => svc).request("/ghost/run", { method: "POST" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("ScheduleNotFoundError");
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

  it("GET /:sid/preview?n=1 plumbs n=1 into the service (1 entry)", async () => {
    const preview = vi.fn(
      async (_expr: string, _tz: string, n = 3): Promise<PreviewResult> => ({
        describe: "x",
        nextRuns: Array.from({ length: n }, (_, i) => `2026-06-0${i + 1}T01:00:00.000Z`),
      }),
    );
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request("/sched-abc/preview?n=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextRuns).toHaveLength(1);
    expect(preview).toHaveBeenCalledWith(sampleSchedule.trigger.expr, sampleSchedule.trigger.tz, 1);
  });

  it("GET /:sid/preview?n=10 plumbs n=10 into the service (10 entries)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc/preview?n=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextRuns).toHaveLength(10);
    expect(svc.preview).toHaveBeenCalledWith(
      sampleSchedule.trigger.expr,
      sampleSchedule.trigger.tz,
      10,
    );
  });

  it("GET /:sid/preview?n=0 returns 400 with typed code", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc/preview?n=0");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ScheduleError");
    expect(svc.preview).not.toHaveBeenCalled();
  });

  it("GET /:sid/preview?n=101 returns 400 with typed code (over upper bound)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc/preview?n=101");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ScheduleError");
    expect(svc.preview).not.toHaveBeenCalled();
  });

  it("GET /:sid/preview?n=abc returns 400 with typed code", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/sched-abc/preview?n=abc");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ScheduleError");
    expect(svc.preview).not.toHaveBeenCalled();
  });

  it("GET /:sid/preview on missing schedule → 404 with typed code", async () => {
    const get = vi.fn(async () => null);
    const svc = stubService({ get });
    const res = await schedulesRoutes(() => svc).request("/missing/preview");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("ScheduleNotFoundError");
  });

  it("GET /:sid/preview maps InvalidCronExprError from service → 400 with typed code", async () => {
    const preview = vi.fn(async () => {
      throw new InvalidCronExprError("bogus", "not a cron");
    });
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request("/sched-abc/preview");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("InvalidCronExprError");
  });
});

describe("schedulesRoutes — previewCron", () => {
  // Unscoped preview-cron route (issue #222) — same shape as
  // `/:sid/preview` but without an entity lookup. Tests mirror the
  // sibling set + add coverage for the route's own validation
  // (required expr / required tz) and for the default n = 5 (vs the
  // sibling's default of 3).

  it("GET /preview-cron returns describe + nextRuns with n defaulting to 5", async () => {
    const preview = vi.fn(
      async (_expr: string, _tz: string, n = 5): Promise<PreviewResult> => ({
        describe: "every day at 09:00",
        nextRuns: Array.from(
          { length: n },
          (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}T01:00:00.000Z`,
        ),
      }),
    );
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request("/preview-cron?expr=0+9+*+*+*&tz=UTC");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.describe).toBe("every day at 09:00");
    // Default n is 5 (modal preview count). The sibling /:sid/preview
    // defaults to 3 — different surfaces, different defaults.
    expect(body.nextRuns).toHaveLength(5);
    expect(preview).toHaveBeenCalledWith("0 9 * * *", "UTC", 5);
  });

  it("GET /preview-cron?n=7 plumbs n=7 into the service", async () => {
    const preview = vi.fn(
      async (_expr: string, _tz: string, n = 5): Promise<PreviewResult> => ({
        describe: "x",
        nextRuns: Array.from({ length: n }, (_, i) => `2026-06-0${i + 1}T01:00:00.000Z`),
      }),
    );
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request(
      "/preview-cron?expr=*%2F5+*+*+*+*&tz=UTC&n=7",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextRuns).toHaveLength(7);
    expect(preview).toHaveBeenCalledWith("*/5 * * * *", "UTC", 7);
  });

  it("GET /preview-cron with missing expr returns 400 without touching the service", async () => {
    const preview = vi.fn();
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request("/preview-cron?tz=UTC");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expr/);
    expect(preview).not.toHaveBeenCalled();
  });

  it("GET /preview-cron with blank expr returns 400 without touching the service", async () => {
    const preview = vi.fn();
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request("/preview-cron?expr=+&tz=UTC");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expr/);
    expect(preview).not.toHaveBeenCalled();
  });

  it("GET /preview-cron with missing tz returns 400 without touching the service", async () => {
    const preview = vi.fn();
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request("/preview-cron?expr=0+9+*+*+*");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tz/);
    expect(preview).not.toHaveBeenCalled();
  });

  it("GET /preview-cron maps InvalidCronExprError from service → 400 with typed code", async () => {
    // The default stub returns 200 for every call, so we MUST override
    // `preview` to throw the typed error. Without this override the
    // test would pass trivially with 200 and the contract under test
    // (typed envelope for cron-validation failure) would be silently
    // unverified.
    const preview = vi.fn(async () => {
      throw new InvalidCronExprError("not a cron", "syntax");
    });
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request("/preview-cron?expr=not+a+cron&tz=UTC");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("InvalidCronExprError");
  });

  it("GET /preview-cron maps InvalidTimezoneError from service → 400 with typed code", async () => {
    // Same override-or-it-passes-trivially caveat as the previous test.
    const preview = vi.fn(async () => {
      throw new InvalidTimezoneError("Mars/Olympus");
    });
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request(
      "/preview-cron?expr=0+9+*+*+*&tz=Mars%2FOlympus",
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("InvalidTimezoneError");
  });

  it("GET /preview-cron?n=0 returns 400 (route rejects, does NOT clamp)", async () => {
    // Issue #222 reads "clamped" in places but the implementation
    // matches `/:sid/preview` — reject with a typed envelope rather
    // than silently clamp. Tests pin the rejection contract.
    const preview = vi.fn();
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request("/preview-cron?expr=0+9+*+*+*&tz=UTC&n=0");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ScheduleError");
    expect(preview).not.toHaveBeenCalled();
  });

  it("GET /preview-cron?n=101 returns 400 (route rejects, does NOT clamp)", async () => {
    const preview = vi.fn();
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request(
      "/preview-cron?expr=0+9+*+*+*&tz=UTC&n=101",
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ScheduleError");
    expect(preview).not.toHaveBeenCalled();
  });

  it("GET /preview-cron?n=1abc returns 400 (strict integer parse rejects)", async () => {
    // Plain `Number.parseInt("1abc")` returns 1; if the route relied on
    // that it would silently accept malformed `n`. The strict check
    // (`String(parsed) === nRaw`) catches it. Sibling /:sid/preview
    // uses the same guard.
    const preview = vi.fn();
    const svc = stubService({ preview });
    const res = await schedulesRoutes(() => svc).request(
      "/preview-cron?expr=0+9+*+*+*&tz=UTC&n=1abc",
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ScheduleError");
    expect(preview).not.toHaveBeenCalled();
  });

  it("GET /preview-cron literal path wins over /:sid match (route-order regression guard)", async () => {
    // If the new route were mounted AFTER `/:sid`, this request would
    // try to load a schedule with sid = "preview-cron" and fall into
    // the entity-lookup path (404, code = ScheduleNotFoundError). The
    // 200 success here pins the mount-order contract: literal route
    // before param route.
    const preview = vi.fn(
      async (_expr: string, _tz: string, n = 5): Promise<PreviewResult> => ({
        describe: "every day at 09:00",
        nextRuns: Array.from({ length: n }, () => "2026-06-01T01:00:00.000Z"),
      }),
    );
    const get = vi.fn();
    const svc = stubService({ preview, get });
    const res = await schedulesRoutes(() => svc).request("/preview-cron?expr=0+9+*+*+*&tz=UTC");
    expect(res.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledTimes(1);
  });
});
