import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCatalog } from "../src/agent/agent-catalog.js";
import { NameInvalid, NotFound } from "../src/errors.js";
import { FsAgentRepository } from "../src/repositories/fs-agent-repository.js";

let catalogDir: string;
let sourceDir: string;
let store: AgentCatalog;

async function makeAgent(
  name: string,
  opts: { deps?: { skills?: string[]; mcps?: string[] } } = {},
): Promise<string> {
  const dir = join(sourceDir, `agent-${name.replace("/", "--")}`);
  await mkdir(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${name}`,
    `description: Agent ${name}`,
    ...(opts.deps
      ? [
          `dependencies:`,
          ...(opts.deps.skills ? [`  skills:`, ...opts.deps.skills.map((s) => `    - ${s}`)] : []),
          ...(opts.deps.mcps ? [`  mcps:`, ...opts.deps.mcps.map((m) => `    - ${m}`)] : []),
        ]
      : []),
    "---",
    "# Instructions",
  ].join("\n");
  await writeFile(join(dir, "AGENTS.md"), lines);
  return dir;
}

beforeEach(async () => {
  const base = join(tmpdir(), `agent-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    it("installs and returns agent", async () => {
      const src = await makeAgent("reviewer");
      const agent = await store.install(src);
      expect(agent.name).toBe("reviewer");
      expect(store.get("reviewer")).toEqual(agent);
    });

    it("installs scoped agent", async () => {
      const src = await makeAgent("langsensei/reviewer");
      const agent = await store.install(src);
      expect(agent.name).toBe("langsensei/reviewer");
    });

    it("upserts on re-install", async () => {
      await store.install(await makeAgent("reviewer"));
      await store.install(await makeAgent("reviewer"));
      expect(store.list()).toHaveLength(1);
    });

    it("rejects invalid name", async () => {
      const dir = join(sourceDir, "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "AGENTS.md"), "---\nname: BAD\ndescription: x\n---\n");
      await expect(store.install(dir)).rejects.toThrow(NameInvalid);
    });

    it("preserves dependencies", async () => {
      const src = await makeAgent("reviewer", { deps: { skills: ["lint"], mcps: ["gh"] } });
      const agent = await store.install(src);
      expect(agent.dependencies).toEqual({ skills: ["lint"], mcps: ["gh"] });
    });
  });

  describe("remove", () => {
    it("removes installed agent", async () => {
      await store.install(await makeAgent("reviewer"));
      await store.remove("reviewer");
      expect(store.get("reviewer")).toBeNull();
    });

    it("throws NotFound for unknown", async () => {
      await expect(store.remove("nope")).rejects.toThrow(NotFound);
    });
  });

  describe("scan", () => {
    it("scans flat agents", async () => {
      const dir = join(catalogDir, "agents", "reviewer");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "AGENTS.md"), "---\nname: reviewer\ndescription: R\n---\n");
      const issues = await store.scan();
      expect(issues).toHaveLength(0);
      expect(store.get("reviewer")!.name).toBe("reviewer");
    });

    it("scans scoped agents", async () => {
      const dir = join(catalogDir, "agents", "langsensei", "reviewer");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "AGENTS.md"),
        "---\nname: langsensei/reviewer\ndescription: R\n---\n",
      );
      await store.scan();
      expect(store.has("langsensei/reviewer")).toBe(true);
    });

    it("records issues for bad frontmatter", async () => {
      const dir = join(catalogDir, "agents", "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "AGENTS.md"), "---\n: invalid\n---\n");
      const issues = await store.scan();
      expect(issues).toHaveLength(1);
    });
  });

  describe("graphNodes", () => {
    it("returns dependency graph", async () => {
      await store.install(
        await makeAgent("reviewer", { deps: { skills: ["lint"], mcps: ["gh"] } }),
      );
      const nodes = store.graphNodes();
      expect(nodes[0]!.dependencies).toEqual(["lint", "gh"]);
    });
  });

  // See SkillCatalog equivalent for rationale.
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
