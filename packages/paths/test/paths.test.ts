import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMPLOKE_HOME, resolveEmplokePaths } from "../src/index.js";

describe("resolveEmplokePaths", () => {
  it("falls back to ~/.emploke when no env is set", () => {
    const p = resolveEmplokePaths({});
    expect(p.home).toBe(path.resolve(homedir(), ".emploke"));
    expect(p.registryFile).toBe(path.join(p.home, "workspaces.json"));
    expect(p.logsDir).toBe(path.join(p.home, "logs"));
  });

  it("default home equals DEFAULT_EMPLOKE_HOME constant", () => {
    expect(resolveEmplokePaths({}).home).toBe(path.resolve(DEFAULT_EMPLOKE_HOME));
  });

  it("EMPLOKE_HOME relocates home and every derived path", () => {
    const p = resolveEmplokePaths({ EMPLOKE_HOME: "/tmp/eh" });
    expect(p.home).toBe(path.resolve("/tmp/eh"));
    expect(p.registryFile).toBe(path.resolve("/tmp/eh/workspaces.json"));
    expect(p.logsDir).toBe(path.resolve("/tmp/eh/logs"));
  });

  it("does NOT expose a global catalogDir field", () => {
    const p = resolveEmplokePaths({ EMPLOKE_HOME: "/tmp/eh" }) as unknown as Record<
      string,
      unknown
    >;
    // Catalog is per-workspace (lives at <workspace>/catalog/) and is not
    // a global path resolved here. Asserting absence guards against
    // accidental reintroduction.
    expect(p.catalogDir).toBeUndefined();
  });

  it("does NOT expose workspacesDir or defaultWorkspaceDir", () => {
    // Workspaces are user-placed; emploke no longer auto-creates a default
    // one under <home>/workspaces/default. Asserting absence guards against
    // accidental reintroduction.
    const p = resolveEmplokePaths({ EMPLOKE_HOME: "/tmp/eh" }) as unknown as Record<
      string,
      unknown
    >;
    expect(p.workspacesDir).toBeUndefined();
    expect(p.defaultWorkspaceDir).toBeUndefined();
  });

  it("treats empty-string EMPLOKE_HOME as unset", () => {
    const p = resolveEmplokePaths({ EMPLOKE_HOME: "" });
    expect(p.home).toBe(path.resolve(homedir(), ".emploke"));
  });

  it("normalises relative paths against cwd", () => {
    const p = resolveEmplokePaths({ EMPLOKE_HOME: "rel/home" });
    expect(path.isAbsolute(p.home)).toBe(true);
    expect(p.home).toBe(path.resolve("rel/home"));
  });
});
