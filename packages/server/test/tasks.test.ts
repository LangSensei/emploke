import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentNotFoundError,
  InvalidTaskIdError,
  RuntimeDoesNotSupportTasksError,
  type Task,
  type TaskManager,
  TaskNotFoundError,
} from "@emploke/task";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    getTaskEventsPath: vi.fn(async () => null),
    ...overrides,
  };
  return stub as unknown as TaskManager;
}

describe("tasksRoutes", () => {
  it("GET / lists tasks", async () => {
    const m = stubManager({});
    const res = await tasksRoutes(m).request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe(sampleTask.id);
    expect(body[0].agent).toBe("writer");
    expect(m.list).toHaveBeenCalledTimes(1);
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
    expect(m.delete).toHaveBeenCalledWith(sampleTask.id);
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

  describe("GET /:tid/events", () => {
    const tmpRoots: string[] = [];
    afterEach(async () => {
      const { rm } = await import("node:fs/promises");
      await Promise.all(
        tmpRoots.splice(0).map((p) => rm(p, { recursive: true, force: true }).catch(() => {})),
      );
    });

    it("404 NoEventsYet when manager returns null (task missing or no log)", async () => {
      // After the Y5 refactor the route delegates path lookup to
      // `TaskManager.getTaskEventsPath`, which collapses both "task
      // missing" and "runtime declined to provide a path" into a single
      // null return. The route surfaces that uniformly as
      // 404 NoEventsYet; the explicit "task missing" 404 lives on
      // GET /:tid (covered separately).
      const m = stubManager({ getTaskEventsPath: vi.fn(async () => null) });
      const res = await tasksRoutes(m).request(`/${sampleTask.id}/events`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NoEventsYet");
    });

    it("404 NoEventsYet when the resolved path doesn't yet exist on disk", async () => {
      // Manager hands back a path the runtime expects to exist
      // eventually but the file isn't there yet (agent hasn't written
      // its first event, or the runtime pre-allocated a parent dir
      // without the log file).
      const root = path.join(tmpdir(), `tasks-events-${Date.now()}-${Math.random()}`);
      await mkdir(root, { recursive: true });
      tmpRoots.push(root);
      const ghostPath = path.join(root, "definitely-not-here.jsonl");
      const m = stubManager({ getTaskEventsPath: vi.fn(async () => ghostPath) });
      const res = await tasksRoutes(m).request(`/${sampleTask.id}/events`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NoEventsYet");
    });

    it("streams the file the manager points us at (runtime-agnostic)", async () => {
      // The route streams whatever bytes are at the manager-supplied
      // path — it neither knows nor cares that this happens to be a
      // Copilot-style NDJSON. A future runtime returning a file with a
      // different format and extension would hit the same code path
      // unchanged.
      const root = path.join(tmpdir(), `tasks-events-${Date.now()}-${Math.random()}`);
      await mkdir(root, { recursive: true });
      tmpRoots.push(root);
      const logPath = path.join(root, "events.jsonl");
      const lines = [
        JSON.stringify({ ts: 1, type: "first" }),
        JSON.stringify({ ts: 2, type: "second" }),
      ].join("\n");
      await writeFile(logPath, `${lines}\n`, "utf8");
      const m = stubManager({ getTaskEventsPath: vi.fn(async () => logPath) });
      const res = await tasksRoutes(m).request(`/${sampleTask.id}/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/x-ndjson/);
      const text = await res.text();
      expect(text).toContain('"first"');
      expect(text).toContain('"second"');
    });
  });
});
