import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HasDependents, NameInvalid, NotFound } from "../src/errors.js";
import { McpCatalog } from "../src/mcp/mcp-catalog.js";
import { FsMcpRepository } from "../src/repositories/fs-mcp-repository.js";

let catalogDir: string;
let sourceDir: string;
let store: McpCatalog;

async function makeMcp(name: string, content?: object): Promise<string> {
  const file = join(sourceDir, `${name.replace("/", "--")}.json`);
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    file,
    JSON.stringify(content ?? { type: "stdio", command: "npx", args: [`@mcp/${name}`] }),
  );
  return file;
}

beforeEach(async () => {
  const base = join(tmpdir(), `mcp-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  catalogDir = join(base, "catalog");
  sourceDir = join(base, "source");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  store = new McpCatalog(new FsMcpRepository(catalogDir));
});

afterEach(async () => {
  await rm(join(catalogDir, ".."), { recursive: true, force: true });
});

describe("McpCatalog", () => {
  describe("install", () => {
    it("installs unscoped mcp", async () => {
      const src = await makeMcp("github");
      const name = await store.install(src);
      expect(name).toBe("github");
      expect(store.has("github")).toBe(true);
    });

    it("installs scoped mcp with explicit name", async () => {
      const src = await makeMcp("mcp");
      const name = await store.install(src, "io.playwright/mcp");
      expect(name).toBe("io.playwright/mcp");
      expect(store.has("io.playwright/mcp")).toBe(true);
    });

    it("upserts on re-install", async () => {
      const src = await makeMcp("github");
      await store.install(src);
      await store.install(src);
      expect(store.list()).toHaveLength(1);
    });

    it("rejects invalid name", async () => {
      const file = join(sourceDir, "BAD.json");
      await writeFile(file, '{"type":"stdio"}');
      await expect(store.install(file)).rejects.toThrow(NameInvalid);
    });

    it("rejects invalid JSON", async () => {
      const file = join(sourceDir, "broken.json");
      await writeFile(file, "not json{");
      await expect(store.install(file)).rejects.toThrow(SyntaxError);
    });
  });

  describe("remove", () => {
    it("removes installed mcp", async () => {
      await store.install(await makeMcp("github"));
      await store.remove("github", () => []);
      expect(store.has("github")).toBe(false);
    });

    it("removes scoped mcp", async () => {
      await store.install(await makeMcp("mcp"), "io.playwright/mcp");
      await store.remove("io.playwright/mcp", () => []);
      expect(store.has("io.playwright/mcp")).toBe(false);
    });

    it("throws NotFound for unknown", async () => {
      await expect(store.remove("nope", () => [])).rejects.toThrow(NotFound);
    });

    it("blocks removal with dependents", async () => {
      await store.install(await makeMcp("github"));
      await expect(store.remove("github", () => ["reviewer"])).rejects.toThrow(HasDependents);
    });
  });

  // `getPath` was removed: MCP path access is now an internal detail of
  // `FsMcpRepository` (the runtime fetches content via getMcpContent so
  // the catalog seam stays backend-agnostic). The path-traversal hardening
  // tests for getContent below cover the remaining public surface; the
  // path-composition hardening lives in `validate.test.ts`.

  describe("scan", () => {
    it("scans flat mcps", async () => {
      const mcpDir = join(catalogDir, "mcps");
      await mkdir(mcpDir, { recursive: true });
      await writeFile(join(mcpDir, "github.json"), '{"type":"stdio"}');
      const issues = await store.scan();
      expect(issues).toHaveLength(0);
      expect(store.has("github")).toBe(true);
    });

    it("scans scoped mcps", async () => {
      const mcpDir = join(catalogDir, "mcps", "io.playwright");
      await mkdir(mcpDir, { recursive: true });
      await writeFile(join(mcpDir, "mcp.json"), '{"type":"stdio"}');
      const issues = await store.scan();
      expect(issues).toHaveLength(0);
      expect(store.has("io.playwright/mcp")).toBe(true);
    });

    it("records issues for bad JSON", async () => {
      const mcpDir = join(catalogDir, "mcps");
      await mkdir(mcpDir, { recursive: true });
      await writeFile(join(mcpDir, "bad.json"), "not json");
      const issues = await store.scan();
      expect(issues).toHaveLength(1);
    });

    it("picks up externally added mcps on rescan", async () => {
      await store.scan();
      expect(store.list()).toHaveLength(0);
      const mcpDir = join(catalogDir, "mcps");
      await mkdir(mcpDir, { recursive: true });
      await writeFile(join(mcpDir, "new-mcp.json"), '{"type":"stdio"}');
      await store.scan();
      expect(store.has("new-mcp")).toBe(true);
    });
  });

  // See SkillCatalog equivalent for rationale.
  describe("getContent path-traversal hardening", () => {
    it("getContent rejects names with `..` segments", async () => {
      await expect(store.getContent("../../../etc/passwd")).rejects.toBeInstanceOf(NameInvalid);
    });
    it("getContent rejects names with multiple slashes", async () => {
      await expect(store.getContent("a/b/c")).rejects.toBeInstanceOf(NameInvalid);
    });
    it("getContent rejects names with backslashes", async () => {
      await expect(store.getContent("..\\..\\etc")).rejects.toBeInstanceOf(NameInvalid);
    });
  });
});
