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

    it("404s when task missing", async () => {
      const m = stubManager({ get: vi.fn(async () => null) });
      const res = await tasksRoutes(m).request(`/${sampleTask.id}/events`);
      expect(res.status).toBe(404);
    });

    it("404 NoEventsYet when workdir metadata absent", async () => {
      const t: Task = { ...sampleTask, metadata: {} };
      const m = stubManager({ get: vi.fn(async () => t) });
      const res = await tasksRoutes(m).request(`/${sampleTask.id}/events`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NoEventsYet");
    });

    it("404 NoEventsYet when events.jsonl not present", async () => {
      const root = path.join(tmpdir(), `tasks-events-${Date.now()}-${Math.random()}`);
      await mkdir(root, { recursive: true });
      tmpRoots.push(root);
      const t: Task = { ...sampleTask, metadata: { ...sampleTask.metadata, workdir: root } };
      const m = stubManager({ get: vi.fn(async () => t) });
      const res = await tasksRoutes(m).request(`/${sampleTask.id}/events`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NoEventsYet");
    });

    it("streams events.jsonl when present", async () => {
      const root = path.join(tmpdir(), `tasks-events-${Date.now()}-${Math.random()}`);
      const sessionDir = path.join(root, "session");
      await mkdir(sessionDir, { recursive: true });
      tmpRoots.push(root);
      const lines = [
        JSON.stringify({ ts: 1, type: "first" }),
        JSON.stringify({ ts: 2, type: "second" }),
      ].join("\n");
      await writeFile(path.join(sessionDir, "events.jsonl"), `${lines}\n`, "utf8");
      const t: Task = { ...sampleTask, metadata: { ...sampleTask.metadata, workdir: root } };
      const m = stubManager({ get: vi.fn(async () => t) });
      const res = await tasksRoutes(m).request(`/${sampleTask.id}/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/x-ndjson/);
      const text = await res.text();
      expect(text).toContain('"first"');
      expect(text).toContain('"second"');
    });
  });
});
