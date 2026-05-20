import { RuntimeHeadlessLaunchFailed } from "@emploke/runtime";
import {
  AgentNotFoundError,
  CorruptedTaskError,
  EntryNotReadyError,
  InvalidTaskIdError,
  InvalidTransition,
  ManagerShuttingDownError,
  RuntimeDoesNotSupportTasksError,
  type Task,
  TaskIdAllocationFailedError,
  type TaskManager,
  TaskNotFoundError,
} from "@emploke/task";
import { describe, expect, it, vi } from "vitest";
import { tasksRoutes } from "../src/routes/tasks.js";

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

function stubManager(overrides: Partial<Record<keyof TaskManager, unknown>>): TaskManager {
  const stub: Partial<Record<keyof TaskManager, unknown>> = {
    list: vi.fn(async () => [sampleTask]),
    get: vi.fn(async () => sampleTask),
    dispatch: vi.fn(async () => sampleTask),
    delete: vi.fn(async () => undefined),
    cancel: vi.fn(async () => sampleTask),
    recoverOrphaned: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    getTaskActivity: vi.fn(async () => null),
    ...overrides,
  };
  return stub as unknown as TaskManager;
}

describe("tasksRoutes", () => {
  it("GET / lists tasks (no filters)", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe(sampleTask.id);
    expect(body[0].agent).toBe("writer");
    expect(m.list).toHaveBeenCalledTimes(1);
    expect(m.list).toHaveBeenCalledWith({});
  });

  it("GET /?agent=X forwards the agent filter to the manager", async () => {
    const list = vi.fn(async () => [sampleTask]);
    const m = stubManager({ list });
    const res = await tasksRoutes(() => m).request("/?agent=writer");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ agent: "writer" });
  });

  it("GET /?runtime=copilot forwards the runtime filter", async () => {
    const list = vi.fn(async () => [sampleTask]);
    const m = stubManager({ list });
    const res = await tasksRoutes(() => m).request("/?runtime=copilot");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ runtime: "copilot" });
  });

  it("GET /?createdSince=<iso> canonicalises the timestamp before forwarding", async () => {
    const list = vi.fn(async () => [sampleTask]);
    const m = stubManager({ list });
    // Send a non-canonical form (no Z suffix); server must canonicalise
    // to ISO 8601 UTC so the manager's lexicographic compare stays
    // correct.
    const res = await tasksRoutes(() => m).request("/?createdSince=2026-05-08T01%3A00%3A00.000Z");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ createdSince: "2026-05-08T01:00:00.000Z" });
  });

  it("GET /?createdSince=garbage returns 400", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/?createdSince=not-a-date");
    expect(res.status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });

  it("GET /?status=running,succeeded forwards the status set", async () => {
    const list = vi.fn(async () => [sampleTask]);
    const m = stubManager({ list });
    const res = await tasksRoutes(() => m).request("/?status=running,succeeded");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ statuses: ["running", "succeeded"] });
  });

  it("GET /?status=bogus returns 400 (unknown status)", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/?status=bogus");
    expect(res.status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });

  it("GET / combines all filters with AND semantics on the manager call", async () => {
    const list = vi.fn(async () => [sampleTask]);
    const m = stubManager({ list });
    const res = await tasksRoutes(() => m).request(
      "/?agent=writer&runtime=copilot&createdSince=2026-05-08T01%3A00%3A00.000Z&status=running",
    );
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      agent: "writer",
      runtime: "copilot",
      createdSince: "2026-05-08T01:00:00.000Z",
      statuses: ["running"],
    });
  });

  it("POST / requires JSON body", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / requires agent", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "go" }),
    });
    expect(res.status).toBe(400);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / requires brief", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/brief/);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / rejects empty brief (whitespace-only)", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "   " }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty/);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / rejects brief containing newline (single-line contract)", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "first line\nsecond line" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/single line/);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / rejects brief containing carriage return", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "first\rsecond" }),
    });
    expect(res.status).toBe(400);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / rejects brief longer than 200 characters", async () => {
    const m = stubManager({});
    const longBrief = "A".repeat(201);
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: longBrief }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/200 characters/);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / accepts brief at exactly 200 characters", async () => {
    const m = stubManager({});
    const exactBrief = "A".repeat(200);
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: exactBrief }),
    });
    expect(res.status).toBe(201);
    expect(m.dispatch).toHaveBeenCalledWith({ agent: "writer", brief: exactBrief });
  });

  it("POST / rejects non-string details", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "ok", details: 7 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/details/);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / rejects non-string runtime", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "hi", runtime: 7 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST / dispatches and returns 201 with brief only", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "Draft the post" }),
    });
    expect(res.status).toBe(201);
    expect(m.dispatch).toHaveBeenCalledWith({
      agent: "writer",
      brief: "Draft the post",
    });
  });

  it("POST / forwards optional details when present", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "writer",
        brief: "Draft the post",
        details: "Tone: warm.\nLength: short.",
      }),
    });
    expect(res.status).toBe(201);
    expect(m.dispatch).toHaveBeenCalledWith({
      agent: "writer",
      brief: "Draft the post",
      details: "Tone: warm.\nLength: short.",
    });
  });

  it("POST / forwards optional runtime override", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "go", runtime: "claude" }),
    });
    expect(res.status).toBe(201);
    expect(m.dispatch).toHaveBeenCalledWith({
      agent: "writer",
      brief: "go",
      runtime: "claude",
    });
  });

  it("POST / trims whitespace from brief before dispatch", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "   Draft the post   " }),
    });
    expect(res.status).toBe(201);
    expect(m.dispatch).toHaveBeenCalledWith({
      agent: "writer",
      brief: "Draft the post",
    });
  });

  it("POST / maps AgentNotFoundError to 400", async () => {
    const m = stubManager({
      dispatch: vi.fn(async () => {
        throw new AgentNotFoundError("ghost");
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

  it("POST / maps RuntimeDoesNotSupportTasksError to 400", async () => {
    const m = stubManager({
      dispatch: vi.fn(async () => {
        throw new RuntimeDoesNotSupportTasksError("legacy");
      }),
    });
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "go" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("RuntimeDoesNotSupportTasksError");
  });

  // Dispatching against a blocked agent must surface the structured
  // error shape (code + message + reason) so the dashboard / CLI can
  // render the actionable reason. Pre-fix this fell through to the
  // generic "internal error" body because EntryNotReadyError wasn't
  // on the safe-name list; pre-I2 it surfaced only `{error, code}`,
  // forcing the dashboard to parse the human message to know which
  // CTA to show.
  it("POST / maps EntryNotReadyError to 409 with code, agent, and structured reason", async () => {
    const m = stubManager({
      dispatch: vi.fn(async () => {
        throw new EntryNotReadyError("public/writer", { needsPrereqsAck: true });
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
    expect(body.error).toContain("not ready");
    // The structured reason is what lets the dashboard render the
    // right CTA (here: Acknowledge prereqs) without string parsing.
    expect(body.agent).toBe("public/writer");
    expect(body.reason).toEqual({ needsPrereqsAck: true });
  });

  it("POST / EntryNotReadyError surfaces blockedDeps cascade (real BlockedReason shape)", async () => {
    const m = stubManager({
      dispatch: vi.fn(async () => {
        throw new EntryNotReadyError("public/writer", {
          blockedDeps: [{ kind: "skill", fqn: "public/missing-prereq" }],
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
    expect(body.reason).toEqual({
      blockedDeps: [{ kind: "skill", fqn: "public/missing-prereq" }],
    });
  });

  it("POST / EntryNotReadyError without a reason still emits the agent field (defensive)", async () => {
    const m = stubManager({
      dispatch: vi.fn(async () => {
        // Defensive path: even if the catalog produced no structured
        // reason (shouldn't happen in practice — getAgentEntry always
        // populates blockedReason on a `blocked` status — but the
        // type allows undefined), the wire body must still carry the
        // agent name so the dashboard can deep-link to that entry.
        throw new EntryNotReadyError("public/writer", undefined);
      }),
    });
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "public/writer", brief: "go" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.agent).toBe("public/writer");
    expect(body.reason).toBeUndefined();
  });

  it("GET /:tid returns task", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request(`/${sampleTask.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(sampleTask.id);
    expect(m.get).toHaveBeenCalledWith(sampleTask.id);
  });

  it("GET /:tid returns 404 when missing", async () => {
    const m = stubManager({ get: vi.fn(async () => null) });
    const res = await tasksRoutes(() => m).request(`/${sampleTask.id}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("TaskNotFoundError");
  });

  // Companion to the manager-level "get() propagates CorruptedTaskError"
  // test: a corrupted row must surface as 5xx with code so operators
  // can see the corruption (a 404 here would let the dashboard render
  // "task gone" for what is really tampered/bit-rotted metadata).
  it("GET /:tid maps CorruptedTaskError to 500 with code", async () => {
    const m = stubManager({
      get: vi.fn(async () => {
        throw new CorruptedTaskError(sampleTask.id, "task.metadata is not valid JSON");
      }),
    });
    const res = await tasksRoutes(() => m).request(`/${sampleTask.id}`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("CorruptedTaskError");
  });

  // Companion for the delete path. Default (archive) mode propagates
  // the corruption; the route maps to 500 with code so the dashboard
  // can prompt the operator to retry with `?purge=1`.
  it("DELETE /:tid maps CorruptedTaskError to 500 with code", async () => {
    const m = stubManager({
      delete: vi.fn(async () => {
        throw new CorruptedTaskError(sampleTask.id, "task.metadata is not valid JSON");
      }),
    });
    const res = await tasksRoutes(() => m).request(`/${sampleTask.id}`, { method: "DELETE" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("CorruptedTaskError");
  });

  it("GET /:tid maps InvalidTaskIdError to 400", async () => {
    const m = stubManager({
      get: vi.fn(async () => {
        throw new InvalidTaskIdError("bad");
      }),
    });
    const res = await tasksRoutes(() => m).request("/bad");
    expect(res.status).toBe(400);
  });

  it("DELETE /:tid returns 204", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(() => m).request(`/${sampleTask.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(m.delete).toHaveBeenCalledWith(sampleTask.id, { purge: false });
  });

  it("DELETE /:tid?purge=1 propagates the purge flag to the manager", async () => {
    const del = vi.fn(async () => undefined);
    const m = stubManager({ delete: del });
    const res = await tasksRoutes(() => m).request(`/${sampleTask.id}?purge=1`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith(sampleTask.id, { purge: true });
  });

  it("DELETE /:tid maps TaskNotFoundError to 404", async () => {
    const m = stubManager({
      delete: vi.fn(async () => {
        throw new TaskNotFoundError(sampleTask.id);
      }),
    });
    const res = await tasksRoutes(() => m).request(`/${sampleTask.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  // Server-side faults must not be reported as client-input errors.
  // Both classes match the analogous mappings in sessions.ts.
  it("POST / maps TaskIdAllocationFailedError to 500 (server-side fs collision)", async () => {
    const m = stubManager({
      dispatch: vi.fn(async () => {
        throw new TaskIdAllocationFailedError(5);
      }),
    });
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "x" }),
    });
    expect(res.status).toBe(500);
  });

  it("POST / maps RuntimeHeadlessLaunchFailed to 500 (host-side spawn failure)", async () => {
    const m = stubManager({
      dispatch: vi.fn(async () => {
        throw new RuntimeHeadlessLaunchFailed("copilot", "/tmp/wd", new Error("ENOENT"));
      }),
    });
    const res = await tasksRoutes(() => m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", brief: "x" }),
    });
    expect(res.status).toBe(500);
  });

  describe("GET /:tid/activity", () => {
    it("404 NoEventsYet when manager returns null (task missing, runtime declines, or no events yet)", async () => {
      // The route delegates the entire read+parse+derive to
      // `TaskManager.getTaskActivity`, which itself fans down to
      // `Runtime.readActivity`. A `null` return collapses every
      // "nothing to show" case (task missing, runtime omits the
      // surface, log file not on disk yet) into a single 404
      // NoEventsYet. The explicit "task missing" 404 lives on
      // GET /:tid (covered separately).
      const m = stubManager({ getTaskActivity: vi.fn(async () => null) });
      const res = await tasksRoutes(() => m).request(`/${sampleTask.id}/activity`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NoEventsYet");
    });

    it("200 forwards the runtime's structured payload as JSON", async () => {
      // The route is a thin pass-through — it neither knows nor cares
      // that this happens to be Copilot's `assistant.message` event
      // model; the runtime owns the read + parse and emits ActivityItems
      // the dashboard renders without runtime-specific knowledge.
      const payload = {
        activity: [
          { kind: "user" as const, timestamp: "2026-05-09T01:00:00.000Z", content: "hi" },
          {
            kind: "assistant" as const,
            timestamp: "2026-05-09T01:00:01.000Z",
            content: "ok",
            toolRequests: [],
          },
        ],
        result: "ok",
      };
      const m = stubManager({ getTaskActivity: vi.fn(async () => payload) });
      const res = await tasksRoutes(() => m).request(`/${sampleTask.id}/activity`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(payload);
    });

    it("forwards before / after / limit query params to the manager", async () => {
      const getTaskActivity = vi.fn(async () => null);
      const m = stubManager({ getTaskActivity });
      const r = tasksRoutes(() => m);

      // Default: no pagination params, default limit 50 applied by route.
      await r.request(`/${sampleTask.id}/activity`);
      expect(getTaskActivity).toHaveBeenLastCalledWith(sampleTask.id, { limit: 50 });

      // after only.
      await r.request(`/${sampleTask.id}/activity?after=42`);
      expect(getTaskActivity).toHaveBeenLastCalledWith(sampleTask.id, { after: 42, limit: 50 });

      // before only.
      await r.request(`/${sampleTask.id}/activity?before=100&limit=20`);
      expect(getTaskActivity).toHaveBeenLastCalledWith(sampleTask.id, {
        before: 100,
        limit: 20,
      });
    });

    it("400 when both before and after are supplied (mutually exclusive)", async () => {
      // The runtime layer also guards this, but failing earlier in the
      // route is friendlier — the client gets a clear 400 rather than
      // having the request hit the runtime and bubble back as a 500.
      const m = stubManager({ getTaskActivity: vi.fn(async () => null) });
      const res = await tasksRoutes(() => m).request(
        `/${sampleTask.id}/activity?before=10&after=5`,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("BadRequest");
      expect(body.error).toContain("mutually exclusive");
    });

    it.each([
      { name: "before negative", q: "before=-1" },
      { name: "before non-integer", q: "before=abc" },
      { name: "before floating point", q: "before=1.5" },
      { name: "after negative", q: "after=-1" },
      { name: "after non-integer", q: "after=xyz" },
      { name: "limit zero", q: "limit=0" },
      { name: "limit > max", q: "limit=10000" },
      { name: "limit non-integer", q: "limit=abc" },
    ])("400 on malformed query: $name", async ({ q }) => {
      const m = stubManager({ getTaskActivity: vi.fn(async () => null) });
      const res = await tasksRoutes(() => m).request(`/${sampleTask.id}/activity?${q}`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("BadRequest");
    });
  });

  // ─── ADR-001: cancel route + delete 409 + 503 mappings ───────────────
  describe("POST /:tid/cancel", () => {
    it("200 + cancelled Task on the happy path", async () => {
      const cancelledTask = {
        ...sampleTask,
        status: "cancelled",
        endedAt: "2026-06-01T00:00:05.000Z",
        cancellation: { kind: "user", message: "cancelled by user" },
      } as unknown as Task;
      const cancel = vi.fn(async () => cancelledTask);
      const m = stubManager({ cancel });
      const res = await tasksRoutes(() => m).request(`/${sampleTask.id}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("cancelled");
      expect(body.cancellation).toEqual({ kind: "user", message: "cancelled by user" });
      expect(cancel).toHaveBeenCalledWith(sampleTask.id);
    });

    it("404 when the task is missing", async () => {
      const m = stubManager({
        cancel: vi.fn(async () => {
          throw new TaskNotFoundError(sampleTask.id);
        }),
      });
      const res = await tasksRoutes(() => m).request(`/${sampleTask.id}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("TaskNotFoundError");
    });

    it("409 + structured InvalidTransition body when the task is already terminal", async () => {
      const m = stubManager({
        cancel: vi.fn(async () => {
          throw new InvalidTransition("success", "cancel");
        }),
      });
      const res = await tasksRoutes(() => m).request(`/${sampleTask.id}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      // R-6: structured envelope so the dashboard branches on code.
      expect(body.code).toBe("InvalidTransition");
      expect(body.status).toBe("success");
      expect(body.transition).toBe("cancel");
      expect(typeof body.error).toBe("string");
    });

    it("503 when the manager is shutting down", async () => {
      const m = stubManager({
        cancel: vi.fn(async () => {
          throw new ManagerShuttingDownError();
        }),
      });
      const res = await tasksRoutes(() => m).request(`/${sampleTask.id}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("ManagerShuttingDownError");
    });
  });

  describe("DELETE /:tid — ADR-001 §3.5 terminal-only", () => {
    it("409 + structured InvalidTransition body when the task is non-terminal", async () => {
      const m = stubManager({
        delete: vi.fn(async () => {
          throw new InvalidTransition("running", "delete");
        }),
      });
      const res = await tasksRoutes(() => m).request(`/${sampleTask.id}`, { method: "DELETE" });
      expect(res.status).toBe(409);
      const body = await res.json();
      // R-6: same envelope shape as the cancel handler — only the
      // transition discriminator differs so the dashboard can branch
      // its 409 handler typed.
      expect(body.code).toBe("InvalidTransition");
      expect(body.status).toBe("running");
      expect(body.transition).toBe("delete");
      expect(typeof body.error).toBe("string");
    });
  });

  // T6 — closes the pre-existing dispatch-side gap (was throwing a bare
  // Error that collapsed to 400) plus pins the new cancel-side mapping.
  describe("503 on shutdown — pinned for dispatch and cancel", () => {
    it("POST / (dispatch) returns 503 when the manager is shutting down", async () => {
      const m = stubManager({
        dispatch: vi.fn(async () => {
          throw new ManagerShuttingDownError();
        }),
      });
      const res = await tasksRoutes(() => m).request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "writer", brief: "x" }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("ManagerShuttingDownError");
    });

    it("POST /:tid/cancel returns 503 when the manager is shutting down", async () => {
      const m = stubManager({
        cancel: vi.fn(async () => {
          throw new ManagerShuttingDownError();
        }),
      });
      const res = await tasksRoutes(() => m).request(`/${sampleTask.id}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(503);
    });
  });
});
