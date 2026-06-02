/**
 * Route-level tests for `routes/scheduled-tasks.ts`. Sibling of
 * `tasks.test.ts` — same stub pattern, same vitest layout. The route
 * is read-only (a single `GET /` handler) so the assertion surface is
 * smaller than `/tasks`; we cover origin pinning, the per-query-param
 * passthrough, the validation 400s, and the AND-compose of every
 * filter at once.
 *
 * Per PR 1 iter (#61): `?origin=` is intentionally NOT a route param
 * here — origin is hardcoded to `['schedule']` server-side. Each
 * origin's caller surface gets a URL whose path IS the contract.
 */

import type { Task, TaskService } from "@emploke/task";
import { describe, expect, it, vi } from "vitest";
import { scheduledTasksRoutes } from "../../src/routes/scheduled-tasks.js";

const sampleScheduledTask: Task = {
  id: "20260601-sched0001",
  agent: "writer",
  brief: "Scheduled draft",
  status: "running",
  origin: "schedule",
  metadata: {
    workdir: "/tmp/wd",
    runtime: "copilot",
    runtimeSessionId: "11111111-2222-3333-4444-555555555555",
    pid: 4242,
    scheduleId: "sched-abc",
  },
  createdAt: "2026-06-01T00:00:00.000Z",
  startedAt: "2026-06-01T00:00:01.000Z",
} as unknown as Task;

function stubManager(overrides: Partial<Record<keyof TaskService, unknown>>): TaskService {
  const stub: Partial<Record<keyof TaskService, unknown>> = {
    list: vi.fn(async () => [sampleScheduledTask]),
    ...overrides,
  };
  return stub as unknown as TaskService;
}

describe("scheduledTasksRoutes", () => {
  it("GET / lists schedule-origin tasks (hardcodes origin=['schedule'])", async () => {
    const m = stubManager({});
    const res = await scheduledTasksRoutes(() => m).request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe(sampleScheduledTask.id);
    expect(m.list).toHaveBeenCalledTimes(1);
    expect(m.list).toHaveBeenCalledWith({ origin: ["schedule"] });
  });

  it("GET /?scheduleId=<id> ANDs the scheduleId filter onto origin=['schedule']", async () => {
    const list = vi.fn(async () => [sampleScheduledTask]);
    const m = stubManager({ list });
    const res = await scheduledTasksRoutes(() => m).request("/?scheduleId=sched-abc");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      origin: ["schedule"],
      scheduleId: "sched-abc",
    });
  });

  it("GET /?status=running,succeeded parses the CSV status set", async () => {
    const list = vi.fn(async () => [sampleScheduledTask]);
    const m = stubManager({ list });
    const res = await scheduledTasksRoutes(() => m).request("/?status=running,succeeded");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      origin: ["schedule"],
      statuses: ["running", "succeeded"],
    });
  });

  it("GET /?status=bogus returns 400 with the same validation envelope /tasks uses", async () => {
    const m = stubManager({});
    const res = await scheduledTasksRoutes(() => m).request("/?status=bogus");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown status/);
    expect(body.error).toMatch(/running, succeeded, failed, cancelled/);
    expect(m.list).not.toHaveBeenCalled();
  });

  it("GET /?createdSince=not-a-date returns 400", async () => {
    const m = stubManager({});
    const res = await scheduledTasksRoutes(() => m).request("/?createdSince=not-a-date");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ISO 8601/);
    expect(m.list).not.toHaveBeenCalled();
  });

  it("GET / AND-composes every filter (scheduleId, agent, runtime, createdSince, status)", async () => {
    const list = vi.fn(async () => [sampleScheduledTask]);
    const m = stubManager({ list });
    const res = await scheduledTasksRoutes(() => m).request(
      "/?createdSince=2026-05-27T00%3A00%3A00.000Z&agent=writer&runtime=copilot&scheduleId=sched-x&status=running",
    );
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      origin: ["schedule"],
      agent: "writer",
      runtime: "copilot",
      createdSince: "2026-05-27T00:00:00.000Z",
      statuses: ["running"],
      scheduleId: "sched-x",
    });
  });

  it("GET / silently ignores ?origin= (origin is route-pinned, not caller-controllable)", async () => {
    // Stale clients sending `?origin=standalone` (or anything else)
    // must not widen the result set. The route just doesn't read the
    // query param; Hono passes it through and the handler ignores it.
    const list = vi.fn(async () => [sampleScheduledTask]);
    const m = stubManager({ list });
    const res = await scheduledTasksRoutes(() => m).request("/?origin=standalone");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ origin: ["schedule"] });
  });
});
