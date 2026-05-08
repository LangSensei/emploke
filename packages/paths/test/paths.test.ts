import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMPLOKE_HOME, resolveEmplokePaths } from "../src/index.js";

describe("resolveEmplokePaths", () => {
  it("falls back to ~/.emploke when no env is set", () => {
    const p = resolveEmplokePaths({});
    expect(p.home).toBe(path.resolve(homedir(), ".emploke"));
    expect(p.catalogDir).toBe(path.join(p.home, "catalog"));
    expect(p.workspacesDir).toBe(path.join(p.home, "workspaces"));
    expect(p.registryFile).toBe(path.join(p.home, "workspaces.json"));
    expect(p.defaultWorkspaceDir).toBe(path.join(p.home, "workspaces", "default"));
  });

  it("default home equals DEFAULT_EMPLOKE_HOME constant", () => {
    expect(resolveEmplokePaths({}).home).toBe(path.resolve(DEFAULT_EMPLOKE_HOME));
  });

  it("EMPLOKE_HOME relocates home and every derived path that wasn't independently overridden", () => {
    const p = resolveEmplokePaths({ EMPLOKE_HOME: "/tmp/eh" });
    expect(p.home).toBe(path.resolve("/tmp/eh"));
    expect(p.catalogDir).toBe(path.resolve("/tmp/eh/catalog"));
    expect(p.workspacesDir).toBe(path.resolve("/tmp/eh/workspaces"));
    expect(p.registryFile).toBe(path.resolve("/tmp/eh/workspaces.json"));
    expect(p.defaultWorkspaceDir).toBe(path.resolve("/tmp/eh/workspaces/default"));
  });

  it("EMPLOKE_CATALOG_DIR overrides catalogDir without affecting home", () => {
    const p = resolveEmplokePaths({
      EMPLOKE_HOME: "/tmp/eh",
      EMPLOKE_CATALOG_DIR: "/srv/shared/catalog",
    });
    expect(p.home).toBe(path.resolve("/tmp/eh"));
    expect(p.catalogDir).toBe(path.resolve("/srv/shared/catalog"));
    expect(p.workspacesDir).toBe(path.resolve("/tmp/eh/workspaces"));
  });

  it("treats empty-string overrides as unset", () => {
    const p = resolveEmplokePaths({
      EMPLOKE_HOME: "",
      EMPLOKE_CATALOG_DIR: "",
    });
    expect(p.home).toBe(path.resolve(homedir(), ".emploke"));
    expect(p.catalogDir).toBe(path.join(p.home, "catalog"));
  });

  it("normalises relative paths against cwd", () => {
    const p = resolveEmplokePaths({ EMPLOKE_HOME: "rel/home" });
    expect(path.isAbsolute(p.home)).toBe(true);
    expect(p.home).toBe(path.resolve("rel/home"));
  });
});
