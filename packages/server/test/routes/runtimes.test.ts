import { RuntimeRegistry } from "@emploke/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { runtimesRoutes } from "../../src/routes/runtimes.js";

function buildApp(registry: RuntimeRegistry): Hono {
  const app = new Hono();
  app.route("/api/runtimes", runtimesRoutes(registry));
  return app;
}

/**
 * Minimal stub Runtime so we don't pull in the copilot adapter (which would
 * touch the filesystem). Only `kind` and the optional `capabilities` matter
 * here — `RuntimeRegistry.kinds()` returns the registered keys and the
 * route reads `runtime.capabilities` to project the response.
 */
function stubRuntime(kind: string, capabilities?: { remoteSession?: boolean }) {
  return {
    kind,
    ...(capabilities !== undefined ? { capabilities } : {}),
    provision: async () => ({ runtimeSessionId: "x" }),
    refresh: async () => null,
    buildInteractiveLaunch: async () => ({ cmd: "x", args: [], cwd: "/", display: "x" }),
    deleteState: async () => undefined,
  };
}

describe("GET /api/runtimes", () => {
  it("returns an empty array when no runtimes are registered", async () => {
    const registry = new RuntimeRegistry();
    const res = await buildApp(registry).request("/api/runtimes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns the registered runtime kinds with empty capabilities by default", async () => {
    const registry = new RuntimeRegistry();
    registry.register(stubRuntime("copilot"));
    registry.register(stubRuntime("gemini"));
    const res = await buildApp(registry).request("/api/runtimes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { kind: "copilot", capabilities: {} },
      { kind: "gemini", capabilities: {} },
    ]);
  });

  it("surfaces a runtime's advertised capability flags verbatim", async () => {
    // The route should pass capabilities through without filtering or
    // adding fields, so the dashboard / future CLI can switch on the
    // raw flags. `remoteSession: true` is the canonical example.
    const registry = new RuntimeRegistry();
    registry.register(stubRuntime("copilot", { remoteSession: true }));
    registry.register(stubRuntime("gemini", {}));
    const res = await buildApp(registry).request("/api/runtimes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { kind: "copilot", capabilities: { remoteSession: true } },
      { kind: "gemini", capabilities: {} },
    ]);
  });
});
