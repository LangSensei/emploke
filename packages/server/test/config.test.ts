import { describe, expect, it } from "vitest";
import { configRoutes, type ServerConfig } from "../src/routes/config.js";

describe("configRoutes", () => {
  it("GET / returns the resolved server config", async () => {
    const res = await configRoutes({
      emplokeHome: "/home/user/.emploke",
      catalogDir: "/home/user/.emploke/catalog",
      host: "127.0.0.1",
      port: 3000,
      pathSeparator: "/",
      currentWorkspace: () => "default",
    }).request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServerConfig;
    expect(body).toEqual({
      emplokeHome: "/home/user/.emploke",
      catalogDir: "/home/user/.emploke/catalog",
      currentWorkspace: "default",
      host: "127.0.0.1",
      port: 3000,
      pathSeparator: "/",
    });
  });

  it("preserves Windows-style separator and path", async () => {
    const res = await configRoutes({
      emplokeHome: "C:\\Users\\Lang\\.emploke",
      catalogDir: "C:\\Users\\Lang\\.emploke\\catalog",
      host: "127.0.0.1",
      port: 3000,
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
      catalogDir: "/h/catalog",
      host: "127.0.0.1",
      port: 3000,
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
