/**
 * Contract tests for PR-G2a (`respondError` + per-domain error
 * policies).
 *
 * These tests pin the cross-cutting behavior the refactor introduced:
 *
 *   1. The 3 `AgentNotFoundError` classes (catalog / task / session)
 *      — same `.name` string, different `.status` per domain — keep
 *      mapping independently. The schedule pkg no longer owns its
 *      own class; its routes reuse the task-pkg class via the kind
 *      handler.
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
import {
  AgentNotFoundError as SessionAgentNotFoundError,
  AgentResolutionFailedError as SessionAgentResolutionFailedError,
} from "@emploke/session";
import {
  EntryNotReadyError,
  InvalidTransition,
  type Task,
  AgentNotFoundError as TaskAgentNotFoundError,
  AgentResolutionFailedError as TaskAgentResolutionFailedError,
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
import { workspacesRoutes } from "../src/routes/workspaces.js";
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
      sessions: {
        list: vi.fn(async () => []),
        create,
        get: vi.fn(),
        delete: vi.fn(),
        spawnInteractive: vi.fn(),
      },
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

  it("schedule route's AgentNotFoundError (task pkg, via kind handler) → 400", async () => {
    // Post-W3 the schedule pkg no longer owns its own
    // AgentNotFoundError class. The task-kind handler
    // (`core/src/wiring/schedule-task-handler.ts`) throws
    // task-pkg's `AgentNotFoundError` directly on catalog miss, and
    // the schedules policy maps that class to 400. The pre-W3
    // duplicate row is collapsed into the single task-pkg row.
    const create = vi.fn(async () => {
      throw new TaskAgentNotFoundError("ghost");
    });
    const stub = { list: vi.fn(async () => []), create } as never;
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
      sessions: {
        list: vi.fn(async () => []),
        create,
        get: vi.fn(),
        delete: vi.fn(),
        spawnInteractive: vi.fn(),
      },
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
      sessions: {
        list,
        create: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        spawnInteractive: vi.fn(),
      },
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

  it("workspaces route unmapped error → 400 + structured log line", async () => {
    // Mirrors the sessions POST-path unmapped test above for the
    // workspaces domain. PR #241 left workspaces.ts behind on the
    // unmapped-fault log seam alongside sessions.ts; PR-G2a closed
    // both. The earlier revision of this file only pinned the
    // sessions side of that gap-close — without a workspaces twin, a
    // future regression that silently drops the log line from a
    // workspaces route would slip past the contract suite (which is
    // exactly the half-completion PR #241 left for G2a to repair).
    const registerWorkspace = vi.fn(async () => {
      throw new Error("ENOSPC: workspace dir mkdir failed");
    });
    const workspacesCtx = {
      workspaceService: {} as never,
      registerWorkspace,
    };
    const { app, cap } = await buildAppWithLogger((a) => {
      a.route("/", workspacesRoutes(workspacesCtx as never));
    });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("internal error");

    const fault = cap.entries.find((e) => e.msg?.includes("unmapped"));
    expect(fault).toBeDefined();
    expect(fault?.level).toBe(50);
    expect(fault?.msg).toBe("workspaces.create: unmapped error fell through to 400");
    expect(fault?.name).toBe("Error");
    expect(fault?.message).toContain("ENOSPC");
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

describe("respondError contract — AgentResolutionFailedError 500 path", () => {
  // The four AgentResolutionFailedError flows (task / session /
  // schedule's-own / schedule-run-delegated-to-task) all collapse to
  // the SAME opaque wire envelope: `{ error: "internal error", code:
  // "AgentResolutionFailedError" }`. The shape is the contract.
  // Each test pins:
  //   - response status === 500
  //   - body.toEqual({ error: "internal error", code: "AgentResolutionFailedError" })
  //     (status-only assertions are explicitly rejected by the brief)
  //   - the `5xx fault` log line fires (so the operator-visible
  //     diagnostic channel still has the cause)
  //
  // Destructive validation:
  //   - tasks/sessions/schedules-create: removing the
  //     `[AgentResolutionFailedError, 500, opaqueAgentResolutionBody]`
  //     row from the corresponding policy makes the assertion fall
  //     through to AgentResolutionFailedError's base-class default
  //     (TaskError → not in policy → 400 unmapped; SessionError → not
  //     in policy → 400 unmapped; ScheduleError → 400 base). The body
  //     code field also disappears (errorBody fallback collapses it
  //     to `{ error: "internal error" }` with no `code`).
  //   - schedules-run: removing the
  //     `[TaskAgentResolutionFailedError, 500, opaqueAgentResolutionBody]`
  //     row from schedules.ts policy causes the task-side
  //     AgentResolutionFailedError to fall through to 400 'unmapped'
  //     (the policy's base class ScheduleError doesn't match the
  //     task-package class). This test will fail with status 400 +
  //     the unmapped log line instead of 500 + the 5xx-fault one.

  const OPAQUE_BODY = {
    error: "internal error",
    code: "AgentResolutionFailedError",
  };

  it("tasks route AgentResolutionFailedError → 500 + opaque body + 5xx fault log", async () => {
    const m = stubTaskService({
      dispatch: vi.fn(async () => {
        throw new TaskAgentResolutionFailedError("public/writer", new Error("DB exploded"));
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
      body: JSON.stringify({ agent: "public/writer", brief: "go" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual(OPAQUE_BODY);

    const fivexx = cap.entries.find((e) => e.msg === "tasks: 5xx fault");
    expect(fivexx).toBeDefined();
    expect(fivexx?.level).toBe(50);
    const unmapped = cap.entries.find((e) => e.msg?.includes("unmapped"));
    expect(unmapped).toBeUndefined();
  });

  it("sessions route AgentResolutionFailedError → 500 + opaque body + 5xx fault log", async () => {
    const create = vi.fn(async () => {
      throw new SessionAgentResolutionFailedError("public/demo", new Error("DB exploded"));
    });
    const sessionsCtx = {
      sessions: {
        list: vi.fn(async () => []),
        create,
        get: vi.fn(),
        delete: vi.fn(),
        spawnInteractive: vi.fn(),
      },
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
      body: JSON.stringify({ agent: "public/demo" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual(OPAQUE_BODY);

    const fivexx = cap.entries.find((e) => e.msg === "sessions: 5xx fault");
    expect(fivexx).toBeDefined();
    expect(fivexx?.level).toBe(50);
    const unmapped = cap.entries.find((e) => e.msg?.includes("unmapped"));
    expect(unmapped).toBeUndefined();
  });

  it("schedules CREATE AgentResolutionFailedError (task pkg, via kind handler) → 500 + opaque body + 5xx fault log", async () => {
    const create = vi.fn(async () => {
      throw new TaskAgentResolutionFailedError("public/writer", new Error("DB exploded"));
    });
    const stub = { list: vi.fn(async () => []), create } as never;
    const { app, cap } = await buildAppWithLogger((a) => {
      a.route(
        "/",
        schedulesRoutes(() => stub),
      );
    });
    const res = await app.request("/task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "S",
        target: { agent: "public/writer", brief: "go" },
        trigger: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual(OPAQUE_BODY);

    const fivexx = cap.entries.find((e) => e.msg?.endsWith(": 5xx fault"));
    expect(fivexx).toBeDefined();
    expect(fivexx?.level).toBe(50);
    const unmapped = cap.entries.find((e) => e.msg?.includes("unmapped"));
    expect(unmapped).toBeUndefined();
  });

  it("schedules-run AgentResolutionFailedError (task package, delegated) → 500 + opaque body + 5xx fault log", async () => {
    // POST /schedules/:sid/run invokes TaskService.dispatch under
    // the hood, so a task-side resolution fault must surface as 500
    // via the schedules policy's task-fallthrough entry. Without
    // the `[TaskAgentResolutionFailedError, 500, ...]` row in
    // schedules.ts, this would fall through to 400 'unmapped'.
    const sid = "550e8400-e29b-41d4-a716-446655440000";
    const run = vi.fn(async () => {
      throw new TaskAgentResolutionFailedError("public/writer", new Error("DB exploded"));
    });
    const stub = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: sid, target: { kind: "task" } })),
      run,
    } as never;
    const { app, cap } = await buildAppWithLogger((a) => {
      a.route(
        "/",
        schedulesRoutes(() => stub),
      );
    });
    const res = await app.request(`/${sid}/run`, { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual(OPAQUE_BODY);

    const fivexx = cap.entries.find((e) => e.msg?.endsWith(": 5xx fault"));
    expect(fivexx).toBeDefined();
    expect(fivexx?.level).toBe(50);
    const unmapped = cap.entries.find((e) => e.msg?.includes("unmapped"));
    expect(unmapped).toBeUndefined();
  });
});
