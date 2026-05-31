/**
 * Contract tests for PR-G2a (`respondError` + per-domain error
 * policies).
 *
 * These tests pin the cross-cutting behavior the refactor introduced:
 *
 *   1. The 4 `AgentNotFoundError` classes (catalog / task / schedule
 *      / session) — same `.name` string, different `.status` per
 *      domain — keep mapping independently.
 *   2. `routes/sessions.ts` and `routes/workspaces.ts` now emit the
 *      structured "unmapped error fell through" log line for
 *      unrecognised errors (the observability gap that PR #241 left
 *      open for these two files).
 *   3. `InvalidTransition` carries the route-context `transition`
 *      verb ("cancel" vs "delete") in its 409 body, proving that the
 *      per-call `customBody` parameter forwards route state through
 *      the helper.
 *   4. `EntryNotReadyError` keeps its structured `{ agent, reason }`
 *      fields on the 409 body via the policy's class-stable body
 *      builder (no longer an inline branch in the route file).
 *   5. 5xx faults (`TaskIdAllocationFailedError`) trip the "5xx
 *      fault" log line WITHOUT the "unmapped" label — the two
 *      observability buckets stay distinct.
 *
 * Sibling per-route suites (`tasks.test.ts`, `sessions.test.ts`, …)
 * cover the per-route fixtures and validation; this file is the
 * cross-cutting safety net.
 */

import { AgentNotFoundError as CatalogAgentNotFoundError } from "@emploke/catalog";
import { AgentNotFoundError as ScheduleAgentNotFoundError } from "@emploke/schedule";
import { AgentNotFoundError as SessionAgentNotFoundError } from "@emploke/session";
import {
  EntryNotReadyError,
  InvalidTransition,
  type Task,
  AgentNotFoundError as TaskAgentNotFoundError,
  TaskIdAllocationFailedError,
  type TaskService,
} from "@emploke/task";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requestId } from "../src/middleware/request-id.js";
import { requestLogger } from "../src/middleware/request-logger.js";
import { catalogRoutes } from "../src/routes/catalog/index.js";
import { scheduledTasksRoutes } from "../src/routes/scheduled-tasks.js";
import { schedulesRoutes } from "../src/routes/schedules.js";
import { sessionsRoutes } from "../src/routes/sessions.js";
import { tasksRoutes } from "../src/routes/tasks.js";
import { captureLogger } from "./_capture-logger.js";

const sampleTask: Task = {
  id: "20260601-abcd1234",
  agent: "writer",
  brief: "Draft the post",
  status: "running",
  metadata: {
    workdir: "/tmp/wd",
    runtime: "copilot",
    runtimeSessionId: "11111111-2222-3333-4444-555555555555",
    pid: 4242,
  },
  createdAt: "2026-06-01T00:00:00.000Z",
  startedAt: "2026-06-01T00:00:01.000Z",
} as unknown as Task;

function stubTaskService(overrides: Partial<Record<keyof TaskService, unknown>>): TaskService {
  return {
    list: vi.fn(async () => [sampleTask]),
    get: vi.fn(async () => sampleTask),
    dispatch: vi.fn(async () => sampleTask),
    delete: vi.fn(async () => undefined),
    cancel: vi.fn(async () => sampleTask),
    ...overrides,
  } as unknown as TaskService;
}

async function buildAppWithLogger(mount: (app: Hono) => void) {
  const cap = captureLogger();
  const app = new Hono();
  app.use("*", requestId());
  app.use("*", requestLogger(cap.logger));
  mount(app);
  return { app, cap };
}

describe("respondError contract — cross-domain status preservation", () => {
  // The four `AgentNotFoundError` classes share the same .name string
  // but extend different bases. The per-domain policies use
  // `instanceof` (not name-string switch), so each route catches the
  // class from its own package and maps independently. Earlier
  // versions of the refactor would have collapsed these if the
  // policies had shared a single error-class set.

  it("task route's AgentNotFoundError (task package) → 400", async () => {
    const m = stubTaskService({
      dispatch: vi.fn(async () => {
        throw new TaskAgentNotFoundError("ghost");
      }),
    });
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "ghost", brief: "go" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("AgentNotFoundError");
  });

  it("session route's AgentNotFoundError (session package) → 400", async () => {
    // Sessions also map their AgentNotFoundError to 400, but the
    // class is a SessionError subclass (not TaskError). Routing via
    // sessionsErrorPolicy proves the instanceof match picks the
    // session-package class, not the task one — same outcome (400),
    // different code path.
    const create = vi.fn(async () => {
      throw new SessionAgentNotFoundError("ghost");
    });
    const sessionsCtx = {
      sessions: { list: vi.fn(async () => []), create, get: vi.fn(), delete: vi.fn() },
      spawnSession: vi.fn(),
    };
    const res = await sessionsRoutes(() => sessionsCtx as never).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "ghost" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("AgentNotFoundError");
  });

  it("schedule route's AgentNotFoundError (schedule package) → 400", async () => {
    const createTask = vi.fn(async () => {
      throw new ScheduleAgentNotFoundError("ghost");
    });
    const stub = { list: vi.fn(async () => []), createTask } as never;
    const res = await schedulesRoutes(() => stub).request("/task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "S",
        target: { agent: "ghost", brief: "go" },
        trigger: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("AgentNotFoundError");
  });

  it("catalog route's AgentNotFoundError (catalog package) → 404 (NOT 400)", async () => {
    // The landmine: the catalog's AgentNotFoundError shares the .name
    // string with the three above, but the catalog-routes policy
    // maps it to 404 (the requested entity isn't in the local
    // catalog). The pre-refactor name-string switch was correct;
    // the post-refactor instanceof-based policy must preserve the
    // same routing without accidentally widening.
    const catalog = {
      getAgentEntry: vi.fn(async () => {
        throw new CatalogAgentNotFoundError("public/ghost");
      }),
    } as never;
    const res = await catalogRoutes(() => catalog).request("/agents/public%2Fghost");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("AgentNotFoundError");
  });
});

describe("respondError contract — unmapped-fault observability gap-closes", () => {
  // The whole point of PR #241 was to emit a structured log line when
  // an unrecognised error class falls through to the default status.
  // PR #241 wired the seam through tasks.ts + scheduled-tasks.ts but
  // left sessions.ts + workspaces.ts behind. PR-G2a closes both gaps
  // via the policy-driven respondError helper.

  it("sessions route unmapped error → 400 + structured log line", async () => {
    const create = vi.fn(async () => {
      throw new Error("ERR_MODULE_NOT_FOUND: cannot resolve @github/copilot-sdk");
    });
    const sessionsCtx = {
      sessions: { list: vi.fn(async () => []), create, get: vi.fn(), delete: vi.fn() },
      spawnSession: vi.fn(),
    };
    const { app, cap } = await buildAppWithLogger((a) => {
      a.route(
        "/",
        sessionsRoutes(() => sessionsCtx as never),
      );
    });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "demo" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("internal error");

    const fault = cap.entries.find((e) => e.msg?.includes("unmapped"));
    expect(fault).toBeDefined();
    expect(fault?.level).toBe(50);
    expect(fault?.msg).toBe("sessions: unmapped error fell through to 400");
    expect(fault?.name).toBe("Error");
    expect(fault?.message).toContain("ERR_MODULE_NOT_FOUND");
  });

  it("sessions: GET / unmapped error → 400 + log line (read path also covered)", async () => {
    // Pre-refactor the list handler returned `c.json(errorBody(err),
    // 400)` with NO log. Now even read paths plumb through
    // respondError so unmapped failures (e.g. sqlite corrupt) are
    // surfaced to the operator.
    const list = vi.fn(async () => {
      throw new Error("metadata.jsonl read failed");
    });
    const sessionsCtx = {
      sessions: { list, create: vi.fn(), get: vi.fn(), delete: vi.fn() },
      spawnSession: vi.fn(),
    };
    const { app, cap } = await buildAppWithLogger((a) => {
      a.route(
        "/",
        sessionsRoutes(() => sessionsCtx as never),
      );
    });
    const res = await app.request("/");
    expect(res.status).toBe(400);
    const fault = cap.entries.find((e) => e.msg?.includes("unmapped"));
    expect(fault).toBeDefined();
    expect(fault?.msg).toBe("sessions.list: unmapped error fell through to 400");
  });

  it("scheduled-tasks unmapped error → 400 + log line (sanity check)", async () => {
    // Confirms the route still uses tasksErrorPolicy and the
    // pre-existing scheduled-tasks.list log message is preserved.
    const m = stubTaskService({
      list: vi.fn(async () => {
        throw new Error("disk read failed");
      }),
    });
    const { app, cap } = await buildAppWithLogger((a) => {
      a.route(
        "/",
        scheduledTasksRoutes(() => m),
      );
    });
    const res = await app.request("/");
    expect(res.status).toBe(400);
    const fault = cap.entries.find((e) => e.msg?.includes("unmapped"));
    expect(fault).toBeDefined();
    expect(fault?.msg).toBe("scheduled-tasks.list: unmapped error fell through to 400");
  });
});

describe("respondError contract — route-dependent custom body", () => {
  it("tasks.cancel returns transition: 'cancel' in InvalidTransition 409", async () => {
    const m = stubTaskService({
      cancel: vi.fn(async () => {
        throw new InvalidTransition("success", "cancel");
      }),
    });
    const res = await tasksRoutes(() => m).request(`/${sampleTask.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("InvalidTransition");
    expect(body.status).toBe("success");
    expect(body.transition).toBe("cancel");
  });

  it("tasks.delete returns transition: 'delete' in InvalidTransition 409", async () => {
    const m = stubTaskService({
      delete: vi.fn(async () => {
        throw new InvalidTransition("running", "delete");
      }),
    });
    const res = await tasksRoutes(() => m).request(`/${sampleTask.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("InvalidTransition");
    expect(body.status).toBe("running");
    expect(body.transition).toBe("delete");
  });
});

describe("respondError contract — class-stable body", () => {
  it("EntryNotReadyError envelope carries { code, agent, reason } on the tasks route", async () => {
    // Lifted from tasks.test.ts. Pinned again here so the contract is
    // expressed once in the cross-cutting suite — if a future change
    // to the policy ever drops the class-stable body builder, this
    // test catches it without having to run the full per-route file.
    const m = stubTaskService({
      dispatch: vi.fn(async () => {
        throw new EntryNotReadyError("public/writer", {
          needsPrereqsAck: true,
          missingDeps: [{ kind: "skill", name: "public/dep" }],
        });
      }),
    });
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "public/writer", brief: "go" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("EntryNotReadyError");
    expect(body.agent).toBe("public/writer");
    expect(body.reason).toBeDefined();
    expect(body.reason.needsPrereqsAck).toBe(true);
  });
});

describe("respondError contract — 5xx fault log separation", () => {
  it("TaskIdAllocationFailedError → 500 + '5xx fault' log, NOT 'unmapped'", async () => {
    // Pre-refactor parity: 5xx faults already had a log entry. The
    // refactor MUST keep them on the "5xx fault" message, not
    // accidentally relabel them as "unmapped" (which would mean the
    // class isn't in the policy — it IS).
    const m = stubTaskService({
      dispatch: vi.fn(async () => {
        throw new TaskIdAllocationFailedError(5);
      }),
    });
    const { app, cap } = await buildAppWithLogger((a) => {
      a.route(
        "/",
        tasksRoutes(() => m),
      );
    });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "go" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    // TaskIdAllocationFailedError IS on SAFE_ERROR_NAMES, so the
    // message + code surface intact on the wire (wire-shape parity
    // with the pre-refactor behavior — errorBody passes it through).
    expect(body.code).toBe("TaskIdAllocationFailedError");
    expect(body.error).toContain("failed to allocate");

    const fivexx = cap.entries.find((e) => e.msg === "tasks: 5xx fault");
    expect(fivexx).toBeDefined();
    const unmapped = cap.entries.find((e) => e.msg?.includes("unmapped"));
    expect(unmapped).toBeUndefined();
  });
});
