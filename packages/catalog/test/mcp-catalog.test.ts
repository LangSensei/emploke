import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HasDependents, NameInvalid, NotFound } from "../src/errors.js";
import { McpCatalog } from "../src/mcp/mcp-catalog.js";
import { FsMcpRepository } from "../src/repositories/fs-mcp-repository.js";
import { makeBase, makeMcpSource } from "./helpers.js";

let catalogDir: string;
let sourceDir: string;
let store: McpCatalog;

beforeEach(async () => {
  const base = makeBase("mcp-store");
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
    it("installs unscoped mcp under local/ scope", async () => {
      const src = await makeMcpSource(sourceDir, "github");
      const fqn = await store.install(src);
      expect(fqn).toBe("local/github");
      expect(store.has("local/github")).toBe(true);
    });

    it("installs scoped mcp via opts.scope override", async () => {
      const src = await makeMcpSource(sourceDir, "mcp");
      const fqn = await store.install(src, { scope: "io.playwright" });
      expect(fqn).toBe("io.playwright/mcp");
      expect(store.has("io.playwright/mcp")).toBe(true);
    });

    it("installs with explicit short name override", async () => {
      const src = await makeMcpSource(sourceDir, "raw");
      const fqn = await store.install(src, { mcpName: "playwright" });
      expect(fqn).toBe("local/playwright");
      expect(store.has("local/playwright")).toBe(true);
    });

    it("upserts on re-install", async () => {
      const src = await makeMcpSource(sourceDir, "github");
      await store.install(src);
      await store.install(src);
      expect(store.list()).toHaveLength(1);
    });

    it("rejects invalid name (uppercase basename)", async () => {
      const file = join(sourceDir, "BAD.json");
      await writeFile(file, '{"type":"stdio"}');
      await expect(store.install(file)).rejects.toThrow(NameInvalid);
    });

    it("rejects invalid JSON", async () => {
      const file = join(sourceDir, "broken.json");
      await writeFile(file, "not json{");
      await expect(store.install(file)).rejects.toThrow(SyntaxError);
    });

    it("persists origin metadata on disk via sidecar", async () => {
      const src = await makeMcpSource(sourceDir, "github");
      await store.install(src, { origin: "https://github.com/example/repo/tree/main/github.json" });
      const meta = store.get("example/github");
      expect(meta?.origin).toBe("https://github.com/example/repo/tree/main/github.json");
      expect(meta?.scope).toBe("example");
    });
  });

  describe("remove", () => {
    it("removes installed mcp", async () => {
      await store.install(await makeMcpSource(sourceDir, "github"));
      await store.remove("local/github", () => []);
      expect(store.has("local/github")).toBe(false);
    });

    it("removes scoped mcp", async () => {
      const src = await makeMcpSource(sourceDir, "mcp");
      await store.install(src, { scope: "io.playwright" });
      await store.remove("io.playwright/mcp", () => []);
      expect(store.has("io.playwright/mcp")).toBe(false);
    });

    it("throws NotFound for unknown", async () => {
      await expect(store.remove("local/nope", () => [])).rejects.toThrow(NotFound);
    });

    it("blocks removal with dependents", async () => {
      await store.install(await makeMcpSource(sourceDir, "github"));
      await expect(store.remove("local/github", () => ["local/reviewer"])).rejects.toThrow(
        HasDependents,
      );
    });
  });

  describe("scan", () => {
    it("scans legacy unscoped flat mcps (auto-scoped to local)", async () => {
      const mcpDir = join(catalogDir, "mcps");
      await mkdir(mcpDir, { recursive: true });
      await writeFile(join(mcpDir, "github.json"), '{"type":"stdio"}');
      const issues = await store.scan();
      expect(issues).toHaveLength(0);
      expect(store.has("local/github")).toBe(true);
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
      expect(store.has("local/new-mcp")).toBe(true);
    });
  });

  describe("getContent path-traversal hardening", () => {
    it("rejects names with `..` segments", async () => {
      await expect(store.getContent("../../../etc/passwd")).rejects.toBeInstanceOf(NameInvalid);
    });
    it("rejects names with multiple slashes", async () => {
      await expect(store.getContent("a/b/c")).rejects.toBeInstanceOf(NameInvalid);
    });
    it("rejects names with backslashes", async () => {
      await expect(store.getContent("..\\..\\etc")).rejects.toBeInstanceOf(NameInvalid);
    });
  });
});
