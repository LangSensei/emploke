import { describe, expect, it } from "vitest";
import { configRoutes, type ServerConfig } from "../src/routes/config.js";

const sample: ServerConfig = {
  catalogDir: "/home/user/.emploke/catalog",
  sessionsRoot: "/home/user/.emploke/sessions",
  host: "127.0.0.1",
  port: 3000,
  pathSeparator: "/",
};

describe("configRoutes", () => {
  it("GET / returns the resolved server config verbatim", async () => {
    const res = await configRoutes(sample).request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServerConfig;
    expect(body).toEqual(sample);
  });

  it("preserves Windows-style separator and path", async () => {
    const win: ServerConfig = {
      catalogDir: "C:\\Users\\Lang\\.emploke\\catalog",
      sessionsRoot: "C:\\Users\\Lang\\.emploke\\sessions",
      host: "127.0.0.1",
      port: 3000,
      pathSeparator: "\\",
    };
    const res = await configRoutes(win).request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServerConfig;
    expect(body.pathSeparator).toBe("\\");
    expect(body.sessionsRoot).toBe("C:\\Users\\Lang\\.emploke\\sessions");
  });
});
