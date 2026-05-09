import { RuntimeRegistry } from "@emploke/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { runtimesRoutes } from "../src/routes/runtimes.js";

function buildApp(registry: RuntimeRegistry): Hono {
  const app = new Hono();
  app.route("/api/runtimes", runtimesRoutes(registry));
  return app;
}

/**
 * Minimal stub Runtime so we don't pull in the copilot adapter (which would
 * touch the filesystem). Only `kind` matters here — `RuntimeRegistry.kinds()`
 * just returns the registered keys.
 */
function stubRuntime(kind: string) {
  return {
    kind,
    provision: async () => "x",
    refresh: async () => null,
    buildLaunch: async () => ({ cmd: "x", args: [], cwd: "/", display: "x" }),
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

  it("returns the registered runtime kinds in registration order", async () => {
    const registry = new RuntimeRegistry();
    registry.register(stubRuntime("copilot"));
    registry.register(stubRuntime("gemini"));
    const res = await buildApp(registry).request("/api/runtimes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["copilot", "gemini"]);
  });
});
