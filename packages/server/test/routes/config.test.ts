import type { ServerConfig } from "@emploke/api";
import { describe, expect, it } from "vitest";
import { configRoutes } from "../../src/routes/config.js";

describe("configRoutes", () => {
  it("GET / returns the resolved server config with default tasks tunables", async () => {
    const res = await configRoutes({
      emplokeHome: "/home/user/.emploke",
      host: "127.0.0.1",
      port: 8787,
      pathSeparator: "/",
      currentWorkspace: () => "default",
    }).request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServerConfig;
    expect(body).toEqual({
      emplokeHome: "/home/user/.emploke",
      currentWorkspace: "default",
      host: "127.0.0.1",
      port: 8787,
      pathSeparator: "/",
      tasks: { pollIntervalMs: 4000 },
    });
  });

  it("honours an explicit taskPollIntervalMs override", async () => {
    const res = await configRoutes({
      emplokeHome: "/h",
      host: "127.0.0.1",
      port: 8787,
      pathSeparator: "/",
      currentWorkspace: () => null,
      taskPollIntervalMs: 1500,
    }).request("/");
    const body = (await res.json()) as ServerConfig;
    expect(body.tasks.pollIntervalMs).toBe(1500);
  });

  it("does not expose a global catalogDir field (catalog is per-workspace)", async () => {
    const res = await configRoutes({
      emplokeHome: "/h",
      host: "127.0.0.1",
      port: 8787,
      pathSeparator: "/",
      currentWorkspace: () => null,
    }).request("/");
    const body = (await res.json()) as ServerConfig & { catalogDir?: unknown };
    expect(body.catalogDir).toBeUndefined();
  });

  it("preserves Windows-style separator and path", async () => {
    const res = await configRoutes({
      emplokeHome: "C:\\Users\\Lang\\.emploke",
      host: "127.0.0.1",
      port: 8787,
      pathSeparator: "\\",
      currentWorkspace: () => null,
    }).request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServerConfig;
    expect(body.pathSeparator).toBe("\\");
    expect(body.emplokeHome).toBe("C:\\Users\\Lang\\.emploke");
    expect(body.currentWorkspace).toBeNull();
  });

  it("evaluates currentWorkspace per request (registry can change)", async () => {
    let current: string | null = "alpha";
    const app = configRoutes({
      emplokeHome: "/h",
      host: "127.0.0.1",
      port: 8787,
      pathSeparator: "/",
      currentWorkspace: () => current,
    });
    let body = (await (await app.request("/")).json()) as ServerConfig;
    expect(body.currentWorkspace).toBe("alpha");
    current = "beta";
    body = (await (await app.request("/")).json()) as ServerConfig;
    expect(body.currentWorkspace).toBe("beta");
  });
});
