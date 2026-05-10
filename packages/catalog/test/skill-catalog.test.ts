import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HasDependents, NameInvalid, NotFound } from "../src/errors.js";
import { FsSkillRepository } from "../src/repositories/fs-skill-repository.js";
import { SkillCatalog } from "../src/skill/skill-catalog.js";
import { dep, makeBase, makeSkillSource, mcpDep } from "./helpers.js";

let catalogDir: string;
let sourceDir: string;
let store: SkillCatalog;

beforeEach(async () => {
  const base = makeBase("skill-store");
  catalogDir = join(base, "catalog");
  sourceDir = join(base, "source");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  store = new SkillCatalog(new FsSkillRepository(catalogDir));
});

afterEach(async () => {
  await rm(join(catalogDir, ".."), { recursive: true, force: true });
});

describe("SkillCatalog", () => {
  describe("install", () => {
    it("installs and returns skill (FQN public/<name> when frontmatter omits scope)", async () => {
      const src = await makeSkillSource(sourceDir, "weather");
      const skill = await store.install(src);
      expect(skill.name).toBe("public/weather");
      expect(skill.shortName).toBe("weather");
      expect(skill.scope).toBe("public");
      expect(store.get("public/weather")).toEqual(skill);
    });

    it("installs scoped skill via frontmatter `scope:`", async () => {
      const src = await makeSkillSource(sourceDir, "weather", { scope: "langsensei" });
      const skill = await store.install(src);
      expect(skill.name).toBe("langsensei/weather");
      expect(store.has("langsensei/weather")).toBe(true);
    });

    it("upserts on re-install", async () => {
      const src1 = await makeSkillSource(sourceDir, "weather");
      await store.install(src1);
      const src2 = await makeSkillSource(sourceDir, "weather");
      await store.install(src2);
      expect(store.list()).toHaveLength(1);
    });

    it("rejects invalid name", async () => {
      const dir = join(sourceDir, "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: Bad_Name\ndescription: x\n---\n");
      await expect(store.install(dir)).rejects.toThrow(NameInvalid);
    });

    it("preserves prereqs", async () => {
      const src = await makeSkillSource(sourceDir, "setup", { prereqs: "npm install" });
      const skill = await store.install(src);
      expect(skill.prereqs).toBe("npm install");
    });

    it("preserves dependencies", async () => {
      const src = await makeSkillSource(sourceDir, "parent", {
        deps: { skills: [dep("child")], mcps: [mcpDep("github/cli")] },
      });
      const skill = await store.install(src);
      expect(skill.dependencies).toEqual({
        skills: [{ name: "child", origin: "file:/test/public/child", scope: "public" }],
        mcps: [{ name: "github/cli", origin: "file:/test/mcps/github_cli.json" }],
      });
    });
  });

  describe("remove", () => {
    it("removes installed skill", async () => {
      const src = await makeSkillSource(sourceDir, "weather");
      await store.install(src);
      await store.remove("public/weather", () => []);
      expect(store.get("public/weather")).toBeNull();
    });

    it("throws NotFound for unknown", async () => {
      await expect(store.remove("public/nope", () => [])).rejects.toThrow(NotFound);
    });

    it("blocks removal with dependents", async () => {
      const src = await makeSkillSource(sourceDir, "leaf");
      await store.install(src);
      await expect(store.remove("public/leaf", () => ["public/parent"])).rejects.toThrow(
        HasDependents,
      );
    });
  });

  describe("get/list/has", () => {
    it("get returns null for unknown", () => {
      expect(store.get("public/nope")).toBeNull();
    });

    it("list returns all installed", async () => {
      await store.install(await makeSkillSource(sourceDir, "a"));
      await store.install(await makeSkillSource(sourceDir, "b"));
      expect(
        store
          .list()
          .map((s) => s.name)
          .sort(),
      ).toEqual(["public/a", "public/b"]);
    });

    it("has returns false for unknown", () => {
      expect(store.has("public/nope")).toBe(false);
    });
  });

  describe("scan", () => {
    it("scans flat skills (legacy unscoped folder → public/ scope)", async () => {
      const dir = join(catalogDir, "skills", "local", "weather");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: weather\ndescription: W\n---\n");
      const issues = await store.scan();
      expect(issues).toHaveLength(0);
      expect(store.get("public/weather")!.name).toBe("public/weather");
    });

    it("scans scoped skills", async () => {
      const dir = join(catalogDir, "skills", "langsensei", "weather");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        "---\nname: weather\nscope: langsensei\ndescription: W\n---\n",
      );
      const issues = await store.scan();
      expect(issues).toHaveLength(0);
      expect(store.has("langsensei/weather")).toBe(true);
    });

    it("records issues for bad frontmatter", async () => {
      const dir = join(catalogDir, "skills", "local", "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: : :\n---\n");
      const issues = await store.scan();
      expect(issues).toHaveLength(1);
      expect(issues[0]!.path).toContain("bad");
    });

    it("picks up externally added skills on rescan", async () => {
      await store.scan();
      expect(store.list()).toHaveLength(0);
      const dir = join(catalogDir, "skills", "local", "new-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: new-skill\ndescription: New\n---\n");
      await store.scan();
      expect(store.has("public/new-skill")).toBe(true);
    });
  });

  describe("graphNodes", () => {
    it("returns dependency graph (FQNs from DependencyRef origins)", async () => {
      await store.install(
        await makeSkillSource(sourceDir, "parent", {
          deps: { skills: [dep("child")], mcps: [mcpDep("github/cli")] },
        }),
      );
      const nodes = store.graphNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.dependencies.sort()).toEqual(["github/cli", "public/child"]);
    });
  });

  // Defense-in-depth: getContent / path / getPath validate names before
  // composing on-disk paths. See SkillCatalog equivalent for rationale.
  describe("getContent path-traversal hardening", () => {
    it("rejects names with `..` segments before reading the filesystem", async () => {
      await expect(store.getContent("../../../etc/passwd")).rejects.toBeInstanceOf(NameInvalid);
    });
    it("rejects names with multiple slashes", async () => {
      await expect(store.getContent("a/b/c")).rejects.toBeInstanceOf(NameInvalid);
    });
    it("rejects names with backslashes (Windows traversal)", async () => {
      await expect(store.getContent("..\\..\\etc")).rejects.toBeInstanceOf(NameInvalid);
    });
    it("rejects names containing `..` even with valid-looking prefix", async () => {
      await expect(store.getContent("foo/..")).rejects.toBeInstanceOf(NameInvalid);
    });
    it("rejects empty string", async () => {
      await expect(store.getContent("")).rejects.toBeInstanceOf(NameInvalid);
    });
  });
});
