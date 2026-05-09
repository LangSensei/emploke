import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCatalog } from "../src/agent/agent-catalog.js";
import { NameInvalid, NotFound } from "../src/errors.js";
import { FsAgentRepository } from "../src/repositories/fs-agent-repository.js";
import { dep, makeAgentSource, makeBase } from "./helpers.js";

let catalogDir: string;
let sourceDir: string;
let store: AgentCatalog;

beforeEach(async () => {
  const base = makeBase("agent-store");
  catalogDir = join(base, "catalog");
  sourceDir = join(base, "source");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  store = new AgentCatalog(new FsAgentRepository(catalogDir));
});

afterEach(async () => {
  await rm(join(catalogDir, ".."), { recursive: true, force: true });
});

describe("AgentCatalog", () => {
  describe("install", () => {
    it("installs and returns agent (FQN local/<name>)", async () => {
      const src = await makeAgentSource(sourceDir, "reviewer");
      const agent = await store.install(src);
      expect(agent.name).toBe("local/reviewer");
      expect(store.get("local/reviewer")).toEqual(agent);
    });

    it("installs scoped agent via frontmatter `scope:`", async () => {
      const src = await makeAgentSource(sourceDir, "reviewer", { scope: "langsensei" });
      const agent = await store.install(src);
      expect(agent.name).toBe("langsensei/reviewer");
    });

    it("upserts on re-install", async () => {
      await store.install(await makeAgentSource(sourceDir, "reviewer"));
      await store.install(await makeAgentSource(sourceDir, "reviewer"));
      expect(store.list()).toHaveLength(1);
    });

    it("rejects invalid name", async () => {
      const dir = join(sourceDir, "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "AGENTS.md"), "---\nname: BAD\ndescription: x\n---\n");
      await expect(store.install(dir)).rejects.toThrow(NameInvalid);
    });

    it("preserves dependencies", async () => {
      const src = await makeAgentSource(sourceDir, "reviewer", {
        deps: { skills: [dep("lint")], mcps: [dep("gh")] },
      });
      const agent = await store.install(src);
      expect(agent.dependencies).toEqual({
        skills: [{ name: "lint", origin: "file:/test/local/lint", scope: "local" }],
        mcps: [{ name: "gh", origin: "file:/test/local/gh", scope: "local" }],
      });
    });
  });

  describe("remove", () => {
    it("removes installed agent", async () => {
      await store.install(await makeAgentSource(sourceDir, "reviewer"));
      await store.remove("local/reviewer");
      expect(store.get("local/reviewer")).toBeNull();
    });

    it("throws NotFound for unknown", async () => {
      await expect(store.remove("local/nope")).rejects.toThrow(NotFound);
    });
  });

  describe("scan", () => {
    it("scans legacy unscoped agents (auto-scoped to local)", async () => {
      const dir = join(catalogDir, "agents", "local", "reviewer");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "AGENTS.md"), "---\nname: reviewer\ndescription: R\n---\n");
      const issues = await store.scan();
      expect(issues).toHaveLength(0);
      expect(store.get("local/reviewer")!.name).toBe("local/reviewer");
    });

    it("scans scoped agents", async () => {
      const dir = join(catalogDir, "agents", "langsensei", "reviewer");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "AGENTS.md"),
        "---\nname: reviewer\nscope: langsensei\ndescription: R\n---\n",
      );
      await store.scan();
      expect(store.has("langsensei/reviewer")).toBe(true);
    });

    it("records issues for bad frontmatter", async () => {
      const dir = join(catalogDir, "agents", "local", "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "AGENTS.md"), "---\n: invalid\n---\n");
      const issues = await store.scan();
      expect(issues).toHaveLength(1);
    });
  });

  describe("graphNodes", () => {
    it("returns dependency graph (FQNs from refs)", async () => {
      await store.install(
        await makeAgentSource(sourceDir, "reviewer", {
          deps: { skills: [dep("lint")], mcps: [dep("gh")] },
        }),
      );
      const nodes = store.graphNodes();
      expect(nodes[0]!.dependencies.sort()).toEqual(["local/gh", "local/lint"]);
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
    it("rejects empty string", async () => {
      await expect(store.getContent("")).rejects.toBeInstanceOf(NameInvalid);
    });
  });
});
