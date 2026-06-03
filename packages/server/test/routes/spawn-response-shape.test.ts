/**
 * Pinning tests for `POST /:sid/spawn`'s failure-response wire shape.
 *
 * The error-mapping logic for terminal-spawn failures lives in
 * `SessionService.spawnInteractive` (in `@emploke/session`) and
 * matches on `err.name`. This file asserts the on-wire JSON body is
 * BYTE-IDENTICAL for each of the three terminal-pkg error classes
 * (NoTerminalFoundError, TerminalSpawnFailedError,
 * UnsupportedPlatformError). It must pass at every commit in the
 * series; if any commit shifts the body, that commit is the bug.
 *
 * This is a route-level pin: the test mounts `sessionsRoutes` with a
 * fake `WorkspaceContext` that has a real `SessionService` instance
 * (constructed against an in-memory db) whose injected `spawnFn`
 * throws the error class under test. The route calls
 * `ctx.sessions.spawnInteractive(...)`, which flows through the
 * production error-mapping branch in `SessionService.spawnInteractive`.
 *
 * Test files are out of scope for the
 * `inter-service-imports.test.ts` architecture fence, so this file
 * can value-import `@emploke/terminal` to instantiate the real
 * error classes.
 */

import type { WorkspaceContext } from "@emploke/api";
import type { CatalogService } from "@emploke/catalog";
import {
  type LaunchCommand,
  type Session,
  SessionService,
  type SessionServiceConfig,
} from "@emploke/session";
import { openTestSessionDb } from "@emploke/session/testing";
import type { TaskService } from "@emploke/task";
import {
  NoTerminalFoundError,
  TerminalSpawnFailedError,
  UnsupportedPlatformError,
} from "@emploke/terminal";
import { describe, expect, it, vi } from "vitest";
import { sessionsRoutes } from "../../src/routes/sessions.js";

const sampleSession: Session = {
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
  args: [`--session-id=${sampleSession.runtimeSessionId}`],
  cwd: sampleSession.workdir,
  display: `cd "${sampleSession.workdir}" && copilot --session-id=${sampleSession.runtimeSessionId}`,
};

/**
 * Build a real SessionService whose `buildInteractiveLaunch` returns
 * `sampleLaunch` synthetically and whose injected `spawnFn` throws
 * the supplied error. The other deps are stubbed to the minimum
 * surface SessionService inspects.
 */
function buildService(spawnError: Error): {
  service: SessionService;
  close: () => void;
} {
  const handle = openTestSessionDb();
  const config: SessionServiceConfig = {
    agentResolver: {
      // sessions are pre-fabricated via spy below; resolver is unused.
      async resolveAgent() {
        throw new Error("unused");
      },
      async getAgentEntry() {
        return null;
      },
    },
    contentSource: {
      async resolveAgent() {
        throw new Error("unused");
      },
      async *agentEntries() {},
      async *skillEntries() {},
      async getMcpRuntimeConfig() {
        return {};
      },
    },
    runtimeRegistry: { get: () => ({}) as never } as never,
    workspaceDir: "/tmp/wd",
    workspaceId: "ws-pin",
    db: handle.db,
    spawnFn: async (_cmd: LaunchCommand) => {
      throw spawnError;
    },
  };
  const service = new SessionService(config);
  // Bypass the real buildInteractiveLaunch (which would hit the
  // repository / runtime). Returning a stable LaunchCommand lets the
  // test focus on the spawn-error branch.
  vi.spyOn(service, "buildInteractiveLaunch").mockImplementation(async () => sampleLaunch);
  return { service, close: () => handle.close() };
}

function buildContext(service: SessionService): WorkspaceContext {
  // Minimal WorkspaceContext fake. The route only touches `.sessions`
  // (for buildInteractiveLaunch / get / etc.) and
  // `.sessions.spawnInteractive()` — the canonical "start an
  // interactive session" call site.
  const ctx: Partial<WorkspaceContext> = {
    sessions: service,
    catalog: {} as CatalogService,
    tasks: {} as TaskService,
  };
  return ctx as WorkspaceContext;
}

describe("POST /:sid/spawn — wire-shape pinning across the option-3 refactor", () => {
  it.each([
    [
      "NoTerminalFoundError",
      () => new NoTerminalFoundError(),
      "No supported terminal emulator was found on this system.",
    ],
    [
      "TerminalSpawnFailedError",
      () => new TerminalSpawnFailedError("wt", "ENOENT"),
      "Failed to launch wt: ENOENT",
    ],
    [
      "UnsupportedPlatformError",
      () => new UnsupportedPlatformError("aix"),
      "Unsupported platform for terminal launch: aix",
    ],
  ])("JSON body for spawn failure with %s matches the pinned shape byte-for-byte", async (expectedCode, mkErr, expectedError) => {
    const { service, close } = buildService(mkErr());
    try {
      const res = await sessionsRoutes(() => buildContext(service)).request(
        `/${sampleSession.id}/spawn`,
        { method: "POST" },
      );
      // 200 because the HTTP request succeeded; the body carries
      // `ok: false` so the dashboard can distinguish "session is
      // fine, terminal isn't".
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        ok: false,
        error: expectedError,
        code: expectedCode,
        display: sampleLaunch.display,
      });
    } finally {
      close();
    }
  });

  it("JSON body on happy spawn matches the pinned shape byte-for-byte", async () => {
    const handle = openTestSessionDb();
    const service = new SessionService({
      agentResolver: {
        async resolveAgent() {
          throw new Error("unused");
        },
        async getAgentEntry() {
          return null;
        },
      },
      contentSource: {
        async resolveAgent() {
          throw new Error("unused");
        },
        async *agentEntries() {},
        async *skillEntries() {},
        async getMcpRuntimeConfig() {
          return {};
        },
      },
      runtimeRegistry: { get: () => ({}) as never } as never,
      workspaceDir: "/tmp/wd",
      workspaceId: "ws-pin",
      db: handle.db,
      spawnFn: async (_cmd: LaunchCommand) => ({ launcher: "wt" as const }),
    });
    vi.spyOn(service, "buildInteractiveLaunch").mockImplementation(async () => sampleLaunch);
    try {
      const res = await sessionsRoutes(() => buildContext(service)).request(
        `/${sampleSession.id}/spawn`,
        { method: "POST" },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        ok: true,
        launcher: "wt",
        display: sampleLaunch.display,
      });
    } finally {
      handle.close();
    }
  });
});
