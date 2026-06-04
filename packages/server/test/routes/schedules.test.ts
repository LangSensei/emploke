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
 *   - wire-shape projection (envelope → flat task target stays
 *     dashboard-compatible)
 */

import {
  InvalidCronExprError,
  InvalidScheduleIdError,
  InvalidTimezoneError,
  type PreviewResult,
  type Schedule,
  ScheduleEnabledError,
  ScheduleHasInFlightError,
  ScheduleKindMismatchError,
  ScheduleNotFoundError,
  type ScheduleService,
} from "@emploke/schedule";
import { AgentNotFoundError, EntryNotReadyError, ManagerShuttingDownError } from "@emploke/task";
import { describe, expect, it, vi } from "vitest";
import { schedulesRoutes } from "../../src/routes/schedules.js";

/**
 * Sample schedule in the new internal envelope shape. The route's
 * `projectScheduleToWire` flattens this for the HTTP response so
 * `body.target.agent` etc. still work on the wire.
 */
const sampleSchedule: Schedule = {
  id: "sched-abc",
  name: "Weekday morning summary",
  target: {
    kind: "task",
    data: {
      agent: "writer",
      brief: "Summarise yesterday's commits",
      details: "Pull yesterday's commit log and produce a short digest grouped by author.",
    },
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
    delete: vi.fn(async () => ({ deletedDispatchCount: 0 })),
    run: vi.fn(async () => ({ dispatchId: "task-001" })),
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
  // Sample as it appears on the WIRE after projectScheduleToWire flattens
  // the internal envelope. The route always returns the flat shape.
  const wireSample = {
    ...sampleSchedule,
    target: {
      kind: "task",
      agent: "writer",
      brief: "Summarise yesterday's commits",
      details: "Pull yesterday's commit log and produce a short digest grouped by author.",
    },
  };

  it("GET / returns the schedule list (flat-target wire shape)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([wireSample]);
    expect(svc.list).toHaveBeenCalledWith({});
  });

  it("GET /?agent=x&enabled=true maps to { kind: 'task', dataEquals, enabled }", async () => {
    const list = vi.fn(async () => []);
    const svc = stubService({ list });
    const res = await schedulesRoutes(() => svc).request("/?agent=writer&enabled=true");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      kind: "task",
      dataEquals: { path: "$.agent", value: "writer" },
      enabled: true,
    });
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
  // POST /task — URL discriminates by kind; body's target has no `kind`.
  const validTarget = {
    agent: "writer",
    brief: "Summarise yesterday's commits",
    details: "Pull yesterday's commit log and produce a short digest grouped by author.",
  };

  it("POST /task creates and returns 201 (flat-target wire shape)", async () => {
    const create = vi.fn(async () => sampleSchedule);
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Weekday morning summary",
        target: validTarget,
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // Wire shape stays flat for task — projectScheduleToWire converts
    // the internal envelope on the way out.
    expect(body.target).toEqual({ kind: "task", ...validTarget });
    expect(create).toHaveBeenCalledTimes(1);
    // The service receives the new envelope shape — wire is flat,
    // internal is `{ kind, data }`.
    expect(create).toHaveBeenCalledWith({
      name: "Weekday morning summary",
      target: { kind: "task", data: validTarget },
      trigger: sampleSchedule.trigger,
    });
  });

  it("POST /task with missing name returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: validTarget,
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name/);
  });

  it("POST /task rejects target.kind in body (URL discriminates)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { kind: "task", ...validTarget },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/kind/);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("POST /task with target null returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: null,
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/target/);
  });

  it("POST /task with unknown nested target key returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { ...validTarget, surprise: 1 },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/surprise|unknown key/);
  });

  it("POST /task with unknown top-level body key returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: validTarget,
        trigger: sampleSchedule.trigger,
        extra: 1,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/extra|unknown key/);
  });

  it("POST /task with missing target.brief returns 400 (route-layer rejection)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { agent: "writer" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/brief/);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("POST /task with target.brief over 200 chars returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { agent: "writer", brief: "x".repeat(201) },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/200/);
  });

  it("POST /task with target.brief containing newline returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { agent: "writer", brief: "foo\nbar" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/single line/);
  });

  it("POST /task with target.brief containing carriage return returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { agent: "writer", brief: "foo\rbar" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/single line/);
  });

  it("POST /task with target.details set to empty string returns 201 (mirrors @emploke/task)", async () => {
    const create = vi.fn(async () => sampleSchedule);
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { agent: "writer", brief: "ok", details: "" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("POST /task with target.details set to a non-string returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { agent: "writer", brief: "ok", details: 7 },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/details/);
  });

  it("POST /task with target.details omitted returns 201", async () => {
    const create = vi.fn(async () => sampleSchedule);
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { agent: "writer", brief: "ok" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("POST /task with invalid cron expr maps to 400 with typed code", async () => {
    const create = vi.fn(async () => {
      throw new InvalidCronExprError("bogus", "not a cron");
    });
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: validTarget,
        trigger: { kind: "cron", expr: "bogus", tz: "UTC" },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("InvalidCronExprError");
  });

  it("POST /task with invalid timezone maps to 400 with typed code", async () => {
    const create = vi.fn(async () => {
      throw new InvalidTimezoneError("Mars/Olympus");
    });
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: validTarget,
        trigger: { kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("InvalidTimezoneError");
  });

  it("POST /task maps task-pkg's AgentNotFoundError → 400 with typed code", async () => {
    // The task kind handler throws task-pkg's AgentNotFoundError
    // directly on catalog miss; the schedule pkg owns no agent-related
    // classes. The schedules-error-policy table has a single row for
    // this class covering both the create/patch validation path AND
    // the /:sid/run dispatch path.
    const create = vi.fn(async () => {
      throw new AgentNotFoundError("ghost-agent");
    });
    const svc = stubService({ create });
    const res = await schedulesRoutes(() => svc).request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        target: { agent: "ghost-agent", brief: "ok" },
        trigger: sampleSchedule.trigger,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("AgentNotFoundError");
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
  it("PATCH /task/:sid forwards the partial body", async () => {
    const patch = vi.fn(async () => sampleSchedule);
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(patch).toHaveBeenCalledWith("sched-abc", { enabled: false, expectedKind: "task" });
  });

  it("PATCH /task/:sid with a non-JSON body returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/JSON/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid maps ScheduleNotFoundError → 404 with typed code", async () => {
    const patch = vi.fn(async () => {
      throw new ScheduleNotFoundError("x");
    });
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/task/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("ScheduleNotFoundError");
  });

  it("PATCH /task/:sid maps ScheduleKindMismatchError → 404 with standard not-found envelope (no kind leak)", async () => {
    const patch = vi.fn(async () => {
      throw new ScheduleKindMismatchError("sched-abc", "task", "workflow");
    });
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    // Wire envelope must look like an ordinary "not found", not like a
    // kind-mismatch (no information leak about the resource's actual
    // kind).
    expect(body.code).toBe("ScheduleNotFoundError");
    expect(JSON.stringify(body)).not.toMatch(/SCHEDULE_KIND_MISMATCH|workflow/i);
  });

  it("PATCH /task/:sid maps InvalidCronExprError → 400 with typed code", async () => {
    const patch = vi.fn(async () => {
      throw new InvalidCronExprError("bogus", "not a cron");
    });
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: { kind: "cron", expr: "bogus", tz: "UTC" } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("InvalidCronExprError");
  });

  it("PATCH /task/:sid maps task.AgentNotFoundError → 400 with typed code", async () => {
    // Mirrors the POST counterpart — task-package
    // `AgentNotFoundError` is caller-fixable input (the FQN points
    // at an agent that's not in the catalog), so 400, not 404. The
    // schedule pkg's own `AgentNotFoundError` was deleted in
    // PR #257; the task handler now imports and re-throws task's
    // class.
    const patch = vi.fn(async () => {
      throw new AgentNotFoundError("ghost-agent");
    });
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: { agent: "ghost-agent" } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("AgentNotFoundError");
  });

  it("PATCH /task/:sid rejects target.kind in body (URL discriminates)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: { kind: "task", agent: "writer" } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/kind/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid rejects target: null", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: null }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/target/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid rejects target.agent: null (required field; omit to keep)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: { agent: null } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/agent/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid rejects target.brief: null (required field; omit to keep)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: { brief: null } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/brief/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid rejects trigger: null", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: null }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/trigger/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid rejects partial trigger (must be wholesale)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: { kind: "cron", expr: "0 9 * * *" } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/trigger/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid rejects unknown nested target key", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: { surprise: 1 } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/surprise|unknown key/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid rejects unknown top-level body key", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extra: 1 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/extra|unknown key/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid with target.brief over 200 chars returns 400 (route-layer rejection)", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { agent: "writer", brief: "x".repeat(201) },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/200/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid with target.brief containing newline returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { agent: "writer", brief: "foo\nbar" },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/single line/);
  });

  it("PATCH /task/:sid with target.details non-string returns 400", async () => {
    const svc = stubService({});
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { agent: "writer", brief: "ok", details: 7 },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/details/);
    expect(svc.patch).not.toHaveBeenCalled();
  });

  it("PATCH /task/:sid with target.details empty string is forwarded (mirrors @emploke/task)", async () => {
    const patch = vi.fn(async () => sampleSchedule);
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { agent: "writer", brief: "ok", details: "" },
      }),
    });
    expect(res.status).toBe(200);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("sched-abc", {
      target: { patch: { agent: "writer", brief: "ok", details: "" } },
      expectedKind: "task",
    });
  });

  it("PATCH /task/:sid with target.details: null forwards as null (RFC 7396 delete)", async () => {
    const patch = vi.fn(async () => sampleSchedule);
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { details: null },
      }),
    });
    expect(res.status).toBe(200);
    expect(patch).toHaveBeenCalledWith("sched-abc", {
      target: { patch: { details: null } },
      expectedKind: "task",
    });
  });

  it("PATCH /task/:sid with target.runtime: null forwards as null (RFC 7396 delete)", async () => {
    const patch = vi.fn(async () => sampleSchedule);
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { runtime: null },
      }),
    });
    expect(res.status).toBe(200);
    expect(patch).toHaveBeenCalledWith("sched-abc", {
      target: { patch: { runtime: null } },
      expectedKind: "task",
    });
  });

  it("PATCH /task/:sid with sparse target forwards only the named fields (deep-merge contract)", async () => {
    const patch = vi.fn(async () => sampleSchedule);
    const svc = stubService({ patch });
    const res = await schedulesRoutes(() => svc).request("/task/sched-abc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { brief: "renamed brief" },
      }),
    });
    expect(res.status).toBe(200);
    // Route does not synthesise sibling fields; the kind handler's
    // mergePatch deep-merges against the persisted entity. The
    // route wraps the validated patch in `{ patch: ... }` per the
    // PatchScheduleArgs.target contract.
    expect(patch).toHaveBeenCalledWith("sched-abc", {
      target: { patch: { brief: "renamed brief" } },
      expectedKind: "task",
    });
  });
});

describe("schedulesRoutes — delete", () => {
  it("DELETE /:sid returns { ok: true, deletedDispatchCount: 0 } when nothing to cascade", async () => {
    const del = vi.fn(async () => ({ deletedDispatchCount: 0 }));
    const svc = stubService({ delete: del });
    const res = await schedulesRoutes(() => svc).request("/sched-abc", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deletedDispatchCount: 0 });
    expect(del).toHaveBeenCalledWith("sched-abc");
  });

  it("DELETE /:sid surfaces the cascade count from the service", async () => {
    const del = vi.fn(async () => ({ deletedDispatchCount: 7 }));
    const svc = stubService({ delete: del });
    const res = await schedulesRoutes(() => svc).request("/sched-abc", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deletedDispatchCount: 7 });
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
  it("POST /:sid/run returns { dispatchId }", async () => {
    const run = vi.fn(async () => ({ dispatchId: "task-fresh" }));
    const svc = stubService({ run });
    const res = await schedulesRoutes(() => svc).request("/sched-abc/run", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatchId: "task-fresh" });
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

  it("POST /:sid/run on task.EntryNotReadyError → 409 with typed code", async () => {
    // Inner `TaskService.dispatch` (called transitively by
    // `ScheduleService.run`) throws when the target agent is
    // `blocked`. The server returns 409 — the dashboard's
    // `formatEntryNotReadyHint` CTA keys off the 409 body, so a
    // collapse to 400 would silently disable that affordance.
    const run = vi.fn(async () => {
      throw new EntryNotReadyError("writer", undefined);
    });
    const svc = stubService({ run });
    const res = await schedulesRoutes(() => svc).request("/sched-abc/run", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("EntryNotReadyError");
  });

  it("POST /:sid/run on task.ManagerShuttingDownError → 503 with typed code", async () => {
    // Dispatch refuses during graceful shutdown so the caller can
    // show a "server restarting" toast and retry. Before the
    // fall-through to `statusForError` landed, this leaked as a
    // 400 and lied about the cause.
    const run = vi.fn(async () => {
      throw new ManagerShuttingDownError();
    });
    const svc = stubService({ run });
    const res = await schedulesRoutes(() => svc).request("/sched-abc/run", { method: "POST" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("ManagerShuttingDownError");
  });

  it("POST /:sid/run on task.AgentNotFoundError → 400 with typed code", async () => {
    // Task's `AgentNotFoundError` is its own class (lives in
    // `@emploke/task`); catalog's `CatalogAgentNotFoundError` is a
    // separate class. The schedule pkg no longer has its own
    // `AgentNotFoundError` post-#257. Pinned separately from the
    // catalog mapping so a future refactor that confuses the two
    // cannot silently regress either mapping.
    const run = vi.fn(async () => {
      throw new AgentNotFoundError("ghost-agent");
    });
    const svc = stubService({ run });
    const res = await schedulesRoutes(() => svc).request("/sched-abc/run", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("AgentNotFoundError");
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
