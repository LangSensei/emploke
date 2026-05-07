import {
  AgentNotFoundError,
  CopilotSessionNotFoundError,
  CopilotStateDeletionFailed,
  InvalidCopilotSessionIdError,
  InvalidSessionIdError,
  type LaunchCommand,
  SessionNotFoundError,
  type SessionRecord,
  type SessionsManager,
} from "@emploke/sessions";
import { describe, expect, it, vi } from "vitest";
import { sessionsRoutes } from "../src/routes/sessions.js";

const sampleRecord: SessionRecord = {
  id: "20260508-010500-9dfbdf05",
  workdir: "/tmp/wd",
  agent: "demo",
  createdAt: new Date("2026-05-08T01:05:00.000Z"),
  copilotSessions: [],
  latestCopilotSession: null,
};

const sampleLaunch: LaunchCommand = {
  cmd: "copilot",
  args: ["-i"],
  cwd: "/tmp/wd",
  display: 'cd "/tmp/wd" && copilot -i',
};

function stubManager(overrides: Partial<Record<keyof SessionsManager, unknown>>): SessionsManager {
  const stub: Partial<Record<keyof SessionsManager, unknown>> = {
    list: vi.fn(async () => [sampleRecord]),
    get: vi.fn(async () => sampleRecord),
    create: vi.fn(async () => sampleRecord),
    delete: vi.fn(async () => undefined),
    getLaunchCommand: vi.fn(async () => sampleLaunch),
    getResumeCommand: vi.fn(async () => sampleLaunch),
    ...overrides,
  };
  return stub as unknown as SessionsManager;
}

describe("sessionsRoutes", () => {
  it("GET / lists sessions", async () => {
    const m = stubManager({});
    const app = sessionsRoutes(m);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe(sampleRecord.id);
    expect(m.list).toHaveBeenCalledWith({});
  });

  it("GET /?agent=demo passes agent filter", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(m).request("/?agent=demo");
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith({ agent: "demo" });
  });

  it("POST / requires JSON body", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(m).request("/", {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/JSON/);
  });

  it("POST / requires agent string", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST / creates session and returns 201", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "demo" }),
    });
    expect(res.status).toBe(201);
    expect(m.create).toHaveBeenCalledWith({ agent: "demo" });
  });

  it("POST / maps AgentNotFoundError to 400", async () => {
    const m = stubManager({
      create: vi.fn(async () => {
        throw new AgentNotFoundError("ghost");
      }),
    });
    const res = await sessionsRoutes(m).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "ghost" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("AgentNotFoundError");
  });

  it("GET /:id returns 404 when not found", async () => {
    const m = stubManager({ get: vi.fn(async () => null) });
    const res = await sessionsRoutes(m).request("/20260508-010500-9dfbdf05");
    expect(res.status).toBe(404);
  });

  it("GET /:id maps InvalidSessionIdError to 400", async () => {
    const m = stubManager({
      get: vi.fn(async () => {
        throw new InvalidSessionIdError("bad");
      }),
    });
    const res = await sessionsRoutes(m).request("/bad");
    expect(res.status).toBe(400);
  });

  it("DELETE /:id maps SessionNotFoundError to 404", async () => {
    const m = stubManager({
      delete: vi.fn(async () => {
        throw new SessionNotFoundError("20260508-010500-9dfbdf05");
      }),
    });
    const res = await sessionsRoutes(m).request("/20260508-010500-9dfbdf05", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /:id?deleteCopilotState=1 propagates option", async () => {
    const del = vi.fn(async () => undefined);
    const m = stubManager({ delete: del });
    const res = await sessionsRoutes(m).request("/20260508-010500-9dfbdf05?deleteCopilotState=1", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith("20260508-010500-9dfbdf05", { deleteCopilotState: true });
  });

  it("DELETE /:id maps CopilotStateDeletionFailed to 409", async () => {
    const m = stubManager({
      delete: vi.fn(async () => {
        throw new CopilotStateDeletionFailed("20260508-010500-9dfbdf05", [
          { copilotSessionId: "x", reason: "EBUSY" },
        ]);
      }),
    });
    const res = await sessionsRoutes(m).request("/20260508-010500-9dfbdf05?deleteCopilotState=1", {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
  });

  it("GET /:id/launch-command returns the command", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(m).request("/20260508-010500-9dfbdf05/launch-command");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cmd).toBe("copilot");
    expect(body.args).toEqual(["-i"]);
  });

  it("GET /:id/resume-command/:sid returns the command", async () => {
    const m = stubManager({});
    const sid = "12345678-1234-1234-1234-1234567890ab";
    const res = await sessionsRoutes(m).request(`/20260508-010500-9dfbdf05/resume-command/${sid}`);
    expect(res.status).toBe(200);
    expect(m.getResumeCommand).toHaveBeenCalledWith("20260508-010500-9dfbdf05", sid);
  });

  it("GET /:id/resume-command/:sid maps InvalidCopilotSessionIdError to 400", async () => {
    const m = stubManager({
      getResumeCommand: vi.fn(async () => {
        throw new InvalidCopilotSessionIdError("not-a-uuid");
      }),
    });
    const res = await sessionsRoutes(m).request(
      "/20260508-010500-9dfbdf05/resume-command/not-a-uuid",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("InvalidCopilotSessionIdError");
  });

  it("GET /:id/resume-command/:sid maps CopilotSessionNotFoundError to 404", async () => {
    const sid = "12345678-1234-1234-1234-1234567890ab";
    const m = stubManager({
      getResumeCommand: vi.fn(async () => {
        throw new CopilotSessionNotFoundError("20260508-010500-9dfbdf05", sid);
      }),
    });
    const res = await sessionsRoutes(m).request(`/20260508-010500-9dfbdf05/resume-command/${sid}`);
    expect(res.status).toBe(404);
  });
});
