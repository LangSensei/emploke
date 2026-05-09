import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HasDependents,
  InvalidMcpJsonError,
  McpNameInvalidError,
  NotFound,
} from "../src/errors.js";
import { McpCatalog } from "../src/mcp/mcp-catalog.js";
import { FsMcpRepository } from "../src/repositories/fs-mcp-repository.js";
import { makeBase } from "./helpers.js";

let catalogDir: string;
let store: McpCatalog;

beforeEach(async () => {
  const base = makeBase("mcp-store");
  catalogDir = join(base, "catalog");
  await mkdir(catalogDir, { recursive: true });
  store = new McpCatalog(new FsMcpRepository(catalogDir));
});

afterEach(async () => {
  await rm(join(catalogDir, ".."), { recursive: true, force: true });
});

const sampleClient = JSON.stringify({ command: "npx", args: ["-y", "@example/mcp"] });

describe("McpCatalog", () => {
  describe("install", () => {
    it("installs an MCP under its spec FQN", async () => {
      const fqn = await store.installFromContent(sampleClient, {
        name: "azure/mcp",
        origin: "https://github.com/Azure/azure-mcp/tree/main/.mcp",
      });
      expect(fqn).toBe("azure/mcp");
      expect(store.has("azure/mcp")).toBe(true);
      const meta = store.get("azure/mcp");
      expect(meta?.namespace).toBe("azure");
      expect(meta?.shortName).toBe("mcp");
    });

    it("installs an MCP with reverse-DNS namespace", async () => {
      const fqn = await store.installFromContent(sampleClient, {
        name: "io.github.user/weather",
        origin: "https://github.com/user/weather-mcp/tree/main/server.json",
      });
      expect(fqn).toBe("io.github.user/weather");
    });

    it("upserts on re-install with same origin", async () => {
      const opts = {
        name: "azure/mcp",
        origin: "https://github.com/Azure/azure-mcp/tree/main",
      };
      await store.installFromContent(sampleClient, opts);
      await store.installFromContent(sampleClient, opts);
      expect(store.list()).toHaveLength(1);
    });

    it("rejects invalid name (no slash)", async () => {
      await expect(
        store.installFromContent(sampleClient, { name: "noslash", origin: "file:/x" }),
      ).rejects.toBeInstanceOf(McpNameInvalidError);
    });

    it("rejects invalid name (multiple slashes)", async () => {
      await expect(
        store.installFromContent(sampleClient, { name: "a/b/c", origin: "file:/x" }),
      ).rejects.toBeInstanceOf(McpNameInvalidError);
    });

    it("rejects invalid JSON content", async () => {
      await expect(
        store.installFromContent("not json", { name: "azure/mcp", origin: "file:/x" }),
      ).rejects.toBeInstanceOf(InvalidMcpJsonError);
    });

    it("persists _meta.{name, origin} inline in the JSON content", async () => {
      const origin = "https://github.com/Azure/azure-mcp/tree/main";
      await store.installFromContent(sampleClient, { name: "azure/mcp", origin });
      const onDisk = await readFile(join(catalogDir, "mcps", "azure", "mcp.json"), "utf8");
      const parsed = JSON.parse(onDisk);
      expect(parsed._meta).toEqual({ name: "azure/mcp", origin });
      // Original client shape preserved.
      expect(parsed.command).toBe("npx");
    });

    it("merge-preserves existing _meta keys (e.g. registry namespaced)", async () => {
      const input = JSON.stringify({
        command: "npx",
        args: ["-y", "@example/mcp"],
        _meta: {
          "io.modelcontextprotocol.registry/version": "1.2.3",
          "io.modelcontextprotocol.registry/published": "2025-01-01",
        },
      });
      await store.installFromContent(input, { name: "example/mcp", origin: "file:/x" });
      const onDisk = await readFile(join(catalogDir, "mcps", "example", "mcp.json"), "utf8");
      const parsed = JSON.parse(onDisk);
      expect(parsed._meta.name).toBe("example/mcp");
      expect(parsed._meta.origin).toBe("file:/x");
      expect(parsed._meta["io.modelcontextprotocol.registry/version"]).toBe("1.2.3");
    });
  });

  describe("remove", () => {
    it("removes an installed MCP", async () => {
      await store.installFromContent(sampleClient, {
        name: "azure/mcp",
        origin: "file:/x",
      });
      await store.remove("azure/mcp", () => []);
      expect(store.has("azure/mcp")).toBe(false);
    });

    it("throws NotFound for unknown", async () => {
      await expect(store.remove("nope/mcp", () => [])).rejects.toThrow(NotFound);
    });

    it("blocks removal with dependents", async () => {
      await store.installFromContent(sampleClient, {
        name: "azure/mcp",
        origin: "file:/x",
      });
      await expect(store.remove("azure/mcp", () => ["local/reviewer"])).rejects.toThrow(
        HasDependents,
      );
    });
  });

  describe("scan", () => {
    it("scans MCPs from two-level layout", async () => {
      const dir = join(catalogDir, "mcps", "azure");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "mcp.json"),
        JSON.stringify({
          command: "npx",
          _meta: { name: "azure/mcp", origin: "file:/x" },
        }),
      );
      const issues = await store.scan();
      expect(issues).toHaveLength(0);
      expect(store.has("azure/mcp")).toBe(true);
    });

    it("records issue when path-derived name doesn't match _meta.name", async () => {
      const dir = join(catalogDir, "mcps", "azure");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "mcp.json"),
        JSON.stringify({
          command: "npx",
          _meta: { name: "wrong/name", origin: "file:/x" },
        }),
      );
      const issues = await store.scan();
      expect(issues).toHaveLength(1);
      expect(issues[0]?.reason).toContain("wrong/name");
    });

    it("records issue when _meta is missing", async () => {
      const dir = join(catalogDir, "mcps", "azure");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "mcp.json"), JSON.stringify({ command: "npx" }));
      const issues = await store.scan();
      expect(issues).toHaveLength(1);
    });
  });

  describe("getContent path-traversal hardening", () => {
    it("rejects names with `..` segments", async () => {
      await expect(store.getContent("../../../etc/passwd")).rejects.toBeInstanceOf(
        McpNameInvalidError,
      );
    });
    it("rejects names with multiple slashes", async () => {
      await expect(store.getContent("a/b/c")).rejects.toBeInstanceOf(McpNameInvalidError);
    });
    it("rejects names with backslashes", async () => {
      await expect(store.getContent("..\\..\\etc")).rejects.toBeInstanceOf(McpNameInvalidError);
    });
  });
});
