import { RuntimeHeadlessLaunchFailed } from "@emploke/runtime";
import {
  AgentNotFoundError,
  CorruptedTaskError,
  EntryNotReadyError,
  InvalidTaskIdError,
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
  instructions: "Draft the post",
  status: "running",
  metadata: {
    workdir: "/tmp/wd",
    runtime: "copilot",
    runtimeSessionId: "11111111-2222-3333-4444-555555555555",
    pid: 4242,
  },
  createdAt: "2026-06-01T00:00:00.000Z",
  startedAt: "2026-06-01T00:00:01.000Z",
};

function stubManager(overrides: Partial<Record<keyof TaskManager, unknown>>): TaskManager {
  const stub: Partial<Record<keyof TaskManager, unknown>> = {
    list: vi.fn(async () => [sampleTask]),
    get: vi.fn(async () => sampleTask),
    dispatch: vi.fn(async () => sampleTask),
    delete: vi.fn(async () => undefined),
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
    const res = await tasksRoutes(m).request("/");
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
    const res = await tasksRoutes(m).request("/?agent=writer");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ agent: "writer" });
  });

  it("GET /?runtime=copilot forwards the runtime filter", async () => {
    const list = vi.fn(async () => [sampleTask]);
    const m = stubManager({ list });
    const res = await tasksRoutes(m).request("/?runtime=copilot");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ runtime: "copilot" });
  });

  it("GET /?createdSince=<iso> canonicalises the timestamp before forwarding", async () => {
    const list = vi.fn(async () => [sampleTask]);
    const m = stubManager({ list });
    // Send a non-canonical form (no Z suffix); server must canonicalise
    // to ISO 8601 UTC so the manager's lexicographic compare stays
    // correct.
    const res = await tasksRoutes(m).request("/?createdSince=2026-05-08T01%3A00%3A00.000Z");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ createdSince: "2026-05-08T01:00:00.000Z" });
  });

  it("GET /?createdSince=garbage returns 400", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(m).request("/?createdSince=not-a-date");
    expect(res.status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });

  it("GET /?status=running,success forwards the status set", async () => {
    const list = vi.fn(async () => [sampleTask]);
    const m = stubManager({ list });
    const res = await tasksRoutes(m).request("/?status=running,success");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ statuses: ["running", "success"] });
  });

  it("GET /?status=bogus returns 400 (unknown status)", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(m).request("/?status=bogus");
    expect(res.status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });

  it("GET / combines all filters with AND semantics on the manager call", async () => {
    const list = vi.fn(async () => [sampleTask]);
    const m = stubManager({ list });
    const res = await tasksRoutes(m).request(
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
    const res = await tasksRoutes(m).request("/", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / requires agent", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "go" }),
    });
    expect(res.status).toBe(400);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / requires instructions", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer" }),
    });
    expect(res.status).toBe(400);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it("POST / rejects non-string runtime", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", instructions: "hi", runtime: 7 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST / dispatches and returns 201", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", instructions: "Draft the post" }),
    });
    expect(res.status).toBe(201);
    expect(m.dispatch).toHaveBeenCalledWith({
      agent: "writer",
      instructions: "Draft the post",
    });
  });

  it("POST / forwards optional runtime override", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", instructions: "go", runtime: "claude" }),
    });
    expect(res.status).toBe(201);
    expect(m.dispatch).toHaveBeenCalledWith({
      agent: "writer",
      instructions: "go",
      runtime: "claude",
    });
  });

  it("POST / maps AgentNotFoundError to 400", async () => {
    const m = stubManager({
      dispatch: vi.fn(async () => {
        throw new AgentNotFoundError("ghost");
      }),
    });
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "ghost", instructions: "go" }),
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
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", instructions: "go" }),
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
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "public/writer", instructions: "go" }),
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
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "public/writer", instructions: "go" }),
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
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "public/writer", instructions: "go" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.agent).toBe("public/writer");
    expect(body.reason).toBeUndefined();
  });

  it("GET /:tid returns task", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(m).request(`/${sampleTask.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(sampleTask.id);
    expect(m.get).toHaveBeenCalledWith(sampleTask.id);
  });

  it("GET /:tid returns 404 when missing", async () => {
    const m = stubManager({ get: vi.fn(async () => null) });
    const res = await tasksRoutes(m).request(`/${sampleTask.id}`);
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
    const res = await tasksRoutes(m).request(`/${sampleTask.id}`);
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
    const res = await tasksRoutes(m).request(`/${sampleTask.id}`, { method: "DELETE" });
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
    const res = await tasksRoutes(m).request("/bad");
    expect(res.status).toBe(400);
  });

  it("DELETE /:tid returns 204", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(m).request(`/${sampleTask.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(m.delete).toHaveBeenCalledWith(sampleTask.id, { purge: false });
  });

  it("DELETE /:tid?purge=1 propagates the purge flag to the manager", async () => {
    const del = vi.fn(async () => undefined);
    const m = stubManager({ delete: del });
    const res = await tasksRoutes(m).request(`/${sampleTask.id}?purge=1`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith(sampleTask.id, { purge: true });
  });

  it("DELETE /:tid maps TaskNotFoundError to 404", async () => {
    const m = stubManager({
      delete: vi.fn(async () => {
        throw new TaskNotFoundError(sampleTask.id);
      }),
    });
    const res = await tasksRoutes(m).request(`/${sampleTask.id}`, { method: "DELETE" });
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
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", instructions: "x" }),
    });
    expect(res.status).toBe(500);
  });

  it("POST / maps RuntimeHeadlessLaunchFailed to 500 (host-side spawn failure)", async () => {
    const m = stubManager({
      dispatch: vi.fn(async () => {
        throw new RuntimeHeadlessLaunchFailed("copilot", "/tmp/wd", new Error("ENOENT"));
      }),
    });
    const res = await tasksRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "writer", instructions: "x" }),
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
      const res = await tasksRoutes(m).request(`/${sampleTask.id}/activity`);
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
      const res = await tasksRoutes(m).request(`/${sampleTask.id}/activity`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(payload);
    });
  });
});
