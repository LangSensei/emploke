import type { SpawnSessionResult, WorkspaceContext } from "@emploke/api";
import type { CatalogService } from "@emploke/catalog";
import {
  AgentNotFoundError,
  InvalidSessionIdError,
  type LaunchCommand,
  RuntimeProvisionFailed,
  RuntimeStateDeletionFailed,
  type Session,
  SessionIdAllocationFailedError,
  SessionNotFoundError,
  type SessionService,
  UnknownRuntimeError,
} from "@emploke/session";
import type { TaskService } from "@emploke/task";
import {
  NoTerminalFoundError,
  type SpawnTerminalResult,
  TerminalSpawnFailedError,
  UnsupportedPlatformError,
} from "@emploke/terminal";
import { describe, expect, it, vi } from "vitest";
import { sessionsRoutes } from "../../src/routes/sessions.js";

const sampleRecord: Session = {
  id: "20260508-9dfbdf05",
  workdir: "/tmp/wd",
  agent: "demo",
  runtime: "copilot",
  runtimeSessionId: "12345678-1234-1234-1234-1234567890ab",
  createdAt: "2026-05-08T01:05:00.000Z",
  lastActiveAt: null,
  preview: null,
  lastLaunchMode: null,
};

const sampleLaunch: LaunchCommand = {
  cmd: "copilot",
  args: ["--session-id=12345678-1234-1234-1234-1234567890ab"],
  cwd: "/tmp/wd",
  display: 'cd "/tmp/wd" && copilot --session-id=12345678-1234-1234-1234-1234567890ab',
};

function stubManager(overrides: Partial<Record<keyof SessionService, unknown>>): SessionService {
  const stub: Partial<Record<keyof SessionService, unknown>> = {
    list: vi.fn(async () => [sampleRecord]),
    get: vi.fn(async () => sampleRecord),
    create: vi.fn(async () => sampleRecord),
    delete: vi.fn(async () => undefined),
    buildInteractiveLaunch: vi.fn(async () => sampleLaunch),
    ...overrides,
  };
  return stub as unknown as SessionService;
}

/**
 * Wrap a SessionService stub into a WorkspaceContext shaped value.
 * Optional `spawnImpl` lets tests inject a terminal spawn fake; the
 * default returns a happy result so spawn tests that don't care can
 * pass an empty stub.
 */
function stubContext(
  sessions: SessionService,
  spawnImpl?: (cmd: LaunchCommand) => Promise<SpawnTerminalResult>,
): WorkspaceContext {
  const context: Partial<WorkspaceContext> = {
    sessions,
    catalog: {} as CatalogService,
    tasks: {} as TaskService,
    async spawnSession(sid, opts): Promise<SpawnSessionResult> {
      const cmd = await sessions.buildInteractiveLaunch(sid, opts ?? {});
      if (spawnImpl === undefined) {
        return { ok: true, launcher: "manual", display: cmd.display };
      }
      try {
        const result = await spawnImpl(cmd);
        return { ok: true, launcher: result.launcher, display: cmd.display };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: spawnErrorCode(err),
          display: cmd.display,
        };
      }
    },
  };
  return context as WorkspaceContext;
}

function spawnErrorCode(err: unknown): string {
  if (err instanceof NoTerminalFoundError) return "NoTerminalFoundError";
  if (err instanceof TerminalSpawnFailedError) return "TerminalSpawnFailedError";
  if (err instanceof UnsupportedPlatformError) return "UnsupportedPlatformError";
  if (err instanceof Error && err.name) return err.name;
  return "SpawnError";
}

describe("sessionsRoutes", () => {
  it("GET / lists sessions", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe(sampleRecord.id);
    expect(body[0].runtime).toBe("copilot");
    expect(body[0].runtimeSessionId).toBe(sampleRecord.runtimeSessionId);
    expect(m.list).toHaveBeenCalledWith({});
  });

  it("GET /?agent=demo passes agent filter", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/?agent=demo");
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith({ agent: "demo" });
  });

  it("GET /?createdSince=ISO passes the timestamp through", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request(
      "/?createdSince=2026-05-01T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith({ createdSince: "2026-05-01T00:00:00.000Z" });
  });

  it("GET /?createdSince combines with agent", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request(
      "/?agent=demo&createdSince=2026-05-01T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith({
      agent: "demo",
      createdSince: "2026-05-01T00:00:00.000Z",
    });
  });

  it("GET /?createdSince=garbage returns 400", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/?createdSince=not-a-date");
    expect(res.status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toMatch(/ISO 8601/);
  });

  it("GET /?createdSince=<non-ISO-but-parseable> normalizes to canonical ISO before passing to manager", async () => {
    // The manager compares createdAt < createdSince lexicographically, which
    // is only correct for canonical ISO 8601 strings. If we forwarded
    // "Jan 1 2024" raw, '2' (ASCII 50) < 'J' (ASCII 74) would silently
    // exclude valid 2026-... sessions. Validate-then-normalize protects
    // the manager from any Date.parse-able input format.
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/?createdSince=Jan 1 2024 UTC");
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith({ createdSince: "2024-01-01T00:00:00.000Z" });
  });

  it("GET /?activeSince=ISO passes the timestamp through", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request(
      "/?activeSince=2026-05-01T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith({ activeSince: "2026-05-01T00:00:00.000Z" });
  });

  it("GET /?activeSince=garbage returns 400", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/?activeSince=not-a-date");
    expect(res.status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toMatch(/activeSince must be an ISO 8601 timestamp/);
  });

  it("GET /?createdSince + ?activeSince combine", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request(
      "/?createdSince=2026-01-01T00:00:00.000Z&activeSince=2026-04-01T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith({
      createdSince: "2026-01-01T00:00:00.000Z",
      activeSince: "2026-04-01T00:00:00.000Z",
    });
  });

  it("GET /?activeSince=<non-ISO-but-parseable> normalises to canonical ISO", async () => {
    // Same canonicalisation rationale as createdSince — the manager's
    // `lastActiveAt < activeSince` lexicographic compare is only
    // correct for canonical ISO 8601 strings. Validates symmetry with
    // the createdSince canonicalisation above.
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/?activeSince=Jan 1 2024 UTC");
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith({ activeSince: "2024-01-01T00:00:00.000Z" });
  });

  it("POST / requires JSON body", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/", {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/JSON/);
  });

  it("POST / requires agent string", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST / rejects non-string runtime", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "demo", runtime: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST / creates session and returns 201", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "demo" }),
    });
    expect(res.status).toBe(201);
    expect(m.create).toHaveBeenCalledWith({ agent: "demo" });
  });

  it("POST / forwards optional runtime override", async () => {
    const m = stubManager({});
    const res = await sessionsRoutes(() => stubContext(m)).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "demo", runtime: "claude" }),
    });
    expect(res.status).toBe(201);
    expect(m.create).toHaveBeenCalledWith({ agent: "demo", runtime: "claude" });
  });

  it("POST / maps AgentNotFoundError to 400", async () => {
    const m = stubManager({
      create: vi.fn(async () => {
        throw new AgentNotFoundError("ghost");
      }),
    });
    const res = await sessionsRoutes(() => stubContext(m)).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "ghost" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("AgentNotFoundError");
  });

  it("POST / maps UnknownRuntimeError to 400", async () => {
    const m = stubManager({
      create: vi.fn(async () => {
        throw new UnknownRuntimeError("gemini");
      }),
    });
    const res = await sessionsRoutes(() => stubContext(m)).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "demo", runtime: "gemini" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("UnknownRuntimeError");
  });

  it("POST / maps RuntimeProvisionFailed to 500 (server-side fault, not a bad request)", async () => {
    const m = stubManager({
      create: vi.fn(async () => {
        throw new RuntimeProvisionFailed("copilot", "/tmp/wd", new Error("mkdir failed"));
      }),
    });
    const res = await sessionsRoutes(() => stubContext(m)).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "demo" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("RuntimeProvisionFailed");
  });

  it("POST / maps SessionIdAllocationFailedError to 500", async () => {
    const m = stubManager({
      create: vi.fn(async () => {
        throw new SessionIdAllocationFailedError(5);
      }),
    });
    const res = await sessionsRoutes(() => stubContext(m)).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "demo" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SessionIdAllocationFailedError");
  });

  it("GET /:id returns 404 when not found", async () => {
    const m = stubManager({ get: vi.fn(async () => null) });
    const res = await sessionsRoutes(() => stubContext(m)).request("/20260508-9dfbdf05");
    expect(res.status).toBe(404);
  });

  it("GET /:id maps InvalidSessionIdError to 400", async () => {
    const m = stubManager({
      get: vi.fn(async () => {
        throw new InvalidSessionIdError("bad");
      }),
    });
    const res = await sessionsRoutes(() => stubContext(m)).request("/bad");
    expect(res.status).toBe(400);
  });

  it("DELETE /:id maps SessionNotFoundError to 404", async () => {
    const m = stubManager({
      delete: vi.fn(async () => {
        throw new SessionNotFoundError("20260508-9dfbdf05");
      }),
    });
    const res = await sessionsRoutes(() => stubContext(m)).request("/20260508-9dfbdf05", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /:id?purge=1 propagates the purge flag (full wipe)", async () => {
    const del = vi.fn(async () => undefined);
    const m = stubManager({ delete: del });
    const res = await sessionsRoutes(() => stubContext(m)).request("/20260508-9dfbdf05?purge=1", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith("20260508-9dfbdf05", { purge: true });
  });

  it("DELETE /:id without ?purge=1 archives (purge defaults to false)", async () => {
    const del = vi.fn(async () => undefined);
    const m = stubManager({ delete: del });
    const res = await sessionsRoutes(() => stubContext(m)).request("/20260508-9dfbdf05", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith("20260508-9dfbdf05", { purge: false });
  });

  it("DELETE /:id maps RuntimeStateDeletionFailed to 409", async () => {
    const m = stubManager({
      delete: vi.fn(async () => {
        throw new RuntimeStateDeletionFailed("copilot", "20260508-9dfbdf05", new Error("EBUSY"));
      }),
    });
    const res = await sessionsRoutes(() => stubContext(m)).request("/20260508-9dfbdf05?purge=1", {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
  });

  describe("POST /:id/spawn", () => {
    it("spawns the launch command", async () => {
      const m = stubManager({});
      const spawn = vi.fn(async () => ({ launcher: "wt" as const }));
      const res = await sessionsRoutes(() => stubContext(m, spawn)).request(
        "/20260508-9dfbdf05/spawn",
        {
          method: "POST",
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.launcher).toBe("wt");
      expect(body.display).toBe(sampleLaunch.display);
      // No body → manager.buildInteractiveLaunch is called with default opts (remote=false).
      expect(m.buildInteractiveLaunch).toHaveBeenCalledWith("20260508-9dfbdf05", { remote: false });
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("forwards remote: true to the manager when body sets it", async () => {
      // The dashboard's "Spawn remote" button posts `{remote: true}`;
      // the route must thread the flag down so the runtime sees it.
      const m = stubManager({});
      const spawn = vi.fn(async () => ({ launcher: "wt" as const }));
      const res = await sessionsRoutes(() => stubContext(m, spawn)).request(
        "/20260508-9dfbdf05/spawn",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ remote: true }),
        },
      );
      expect(res.status).toBe(200);
      expect(m.buildInteractiveLaunch).toHaveBeenCalledWith("20260508-9dfbdf05", { remote: true });
    });

    it("rejects a non-boolean `remote` value with 400", async () => {
      // Defends the wire contract — clients should send a literal
      // boolean, not a string or number, even when the value coerces.
      const m = stubManager({});
      const res = await sessionsRoutes(() => stubContext(m)).request("/20260508-9dfbdf05/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remote: "yes" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns ok:false with display on terminal spawn failure", async () => {
      const m = stubManager({});
      const spawn = vi.fn(async () => {
        throw new Error("ENOENT: terminal not found");
      });
      const res = await sessionsRoutes(() => stubContext(m, spawn)).request(
        "/20260508-9dfbdf05/spawn",
        {
          method: "POST",
        },
      );
      // 200 because the request itself succeeded; the body carries ok:false
      // so the dashboard can distinguish "session is fine, terminal isn't".
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.display).toBe(sampleLaunch.display);
      expect(body.error).toMatch(/ENOENT/);
    });

    it("propagates SessionNotFoundError as 404", async () => {
      const m = stubManager({
        buildInteractiveLaunch: vi.fn(async () => {
          throw new SessionNotFoundError("20260508-9dfbdf05");
        }),
      });
      const spawn = vi.fn();
      const res = await sessionsRoutes(() => stubContext(m, spawn)).request(
        "/20260508-9dfbdf05/spawn",
        {
          method: "POST",
        },
      );
      expect(res.status).toBe(404);
      expect(spawn).not.toHaveBeenCalled();
    });

    it("propagates InvalidSessionIdError as 400", async () => {
      const m = stubManager({
        buildInteractiveLaunch: vi.fn(async () => {
          throw new InvalidSessionIdError("bad");
        }),
      });
      const spawn = vi.fn();
      const res = await sessionsRoutes(() => stubContext(m, spawn)).request("/bad/spawn", {
        method: "POST",
      });
      expect(res.status).toBe(400);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  // Regression for the param-shadowing bug surfaced in the dashboard:
  // when sessions used `:id` as its inner path param it collided with the
  // outer mount's `/:id/sessions/*` workspace param. Hono's
  // `c.req.param("id")` then returned the workspace UUID instead of the
  // session id, and `assertValidSessionId` rejected it. We mount sessions
  // under a parent app the same way `index.ts` does and assert the inner
  // handler sees the *session* id.
  describe("nested under /api/workspaces/:wsid/sessions", () => {
    it("DELETE delivers the session id (not the workspace id) to the manager", async () => {
      const { Hono } = await import("hono");
      const del = vi.fn(async () => undefined);
      const m = stubManager({ delete: del });
      // Re-import the helper from the runtime package: outer mount uses
      // the same `:id` Hono lifted into its own scope. We could call this
      // param `:wsid` instead, but that wouldn't catch a future regression;
      // the production wiring really does use `:id` on the outer mount.
      const parent = new Hono();
      parent.route(
        "/api/workspaces/:id/sessions",
        sessionsRoutes(() => stubContext(m)),
      );
      const wsId = "3e8b2d26-3cac-4d0e-9878-f1abe542e2d0"; // a UUID
      const sid = "20260508-9dfbdf05";
      const res = await parent.request(`/api/workspaces/${wsId}/sessions/${sid}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
      expect(del).toHaveBeenCalledWith(sid, { purge: false });
      // Negative assertion: the workspace UUID must never reach the manager.
      expect(del).not.toHaveBeenCalledWith(wsId, expect.anything());
    });
  });
});
