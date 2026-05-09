import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HasDependents, NameInvalid, NotFound } from "../src/errors.js";
import { FsSkillRepository } from "../src/repositories/fs-skill-repository.js";
import { SkillStore } from "../src/skill/skill-store.js";

let catalogDir: string;
let sourceDir: string;
let store: SkillStore;

async function makeSkill(
  name: string,
  opts: { deps?: { skills?: string[]; mcps?: string[] }; prereqs?: string } = {},
): Promise<string> {
  const dir = join(sourceDir, name.replace("/", "--"));
  await mkdir(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${name}`,
    `description: Skill ${name}`,
    ...(opts.deps
      ? [
          `dependencies:`,
          ...(opts.deps.skills ? [`  skills:`, ...opts.deps.skills.map((s) => `    - ${s}`)] : []),
          ...(opts.deps.mcps ? [`  mcps:`, ...opts.deps.mcps.map((m) => `    - ${m}`)] : []),
        ]
      : []),
    ...(opts.prereqs ? [`prereqs: "${opts.prereqs}"`] : []),
    "---",
    "# Instructions",
  ].join("\n");
  await writeFile(join(dir, "SKILL.md"), lines);
  return dir;
}

beforeEach(async () => {
  const base = join(tmpdir(), `skill-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  catalogDir = join(base, "catalog");
  sourceDir = join(base, "source");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  store = new SkillStore(new FsSkillRepository(catalogDir));
});

afterEach(async () => {
  await rm(join(catalogDir, ".."), { recursive: true, force: true });
});

describe("SkillStore", () => {
  describe("install", () => {
    it("installs and returns skill", async () => {
      const src = await makeSkill("weather");
      const skill = await store.install(src);
      expect(skill.name).toBe("weather");
      expect(store.get("weather")).toEqual(skill);
    });

    it("installs scoped skill", async () => {
      const src = await makeSkill("langsensei/weather");
      const skill = await store.install(src);
      expect(skill.name).toBe("langsensei/weather");
      expect(store.has("langsensei/weather")).toBe(true);
    });

    it("upserts on re-install", async () => {
      const src1 = await makeSkill("weather");
      await store.install(src1);
      const src2 = await makeSkill("weather");
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
      const src = await makeSkill("setup", { prereqs: "npm install" });
      const skill = await store.install(src);
      expect(skill.prereqs).toBe("npm install");
    });

    it("preserves dependencies", async () => {
      const src = await makeSkill("parent", { deps: { skills: ["child"], mcps: ["gh"] } });
      const skill = await store.install(src);
      expect(skill.dependencies).toEqual({ skills: ["child"], mcps: ["gh"] });
    });
  });

  describe("remove", () => {
    it("removes installed skill", async () => {
      const src = await makeSkill("weather");
      await store.install(src);
      await store.remove("weather", () => []);
      expect(store.get("weather")).toBeNull();
    });

    it("throws NotFound for unknown", async () => {
      await expect(store.remove("nope", () => [])).rejects.toThrow(NotFound);
    });

    it("blocks removal with dependents", async () => {
      const src = await makeSkill("leaf");
      await store.install(src);
      await expect(store.remove("leaf", () => ["parent"])).rejects.toThrow(HasDependents);
    });
  });

  describe("get/list/has", () => {
    it("get returns null for unknown", () => {
      expect(store.get("nope")).toBeNull();
    });

    it("list returns all installed", async () => {
      await store.install(await makeSkill("a"));
      await store.install(await makeSkill("b"));
      expect(
        store
          .list()
          .map((s) => s.name)
          .sort(),
      ).toEqual(["a", "b"]);
    });

    it("has returns false for unknown", () => {
      expect(store.has("nope")).toBe(false);
    });
  });

  describe("scan", () => {
    it("scans flat skills", async () => {
      const dir = join(catalogDir, "skills", "weather");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: weather\ndescription: W\n---\n");
      const issues = await store.scan();
      expect(issues).toHaveLength(0);
      expect(store.get("weather")!.name).toBe("weather");
    });

    it("scans scoped skills", async () => {
      const dir = join(catalogDir, "skills", "langsensei", "weather");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        "---\nname: langsensei/weather\ndescription: W\n---\n",
      );
      const issues = await store.scan();
      expect(issues).toHaveLength(0);
      expect(store.has("langsensei/weather")).toBe(true);
    });

    it("records issues for bad frontmatter", async () => {
      const dir = join(catalogDir, "skills", "bad");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: : :\n---\n");
      const issues = await store.scan();
      expect(issues).toHaveLength(1);
      expect(issues[0]!.path).toContain("bad");
    });

    it("picks up externally added skills on rescan", async () => {
      await store.scan(); // empty
      expect(store.list()).toHaveLength(0);
      // Simulate external write
      const dir = join(catalogDir, "skills", "new-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: new-skill\ndescription: New\n---\n");
      await store.scan();
      expect(store.has("new-skill")).toBe(true);
    });
  });

  describe("graphNodes", () => {
    it("returns dependency graph", async () => {
      await store.install(await makeSkill("parent", { deps: { skills: ["child"], mcps: ["gh"] } }));
      const nodes = store.graphNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.dependencies).toEqual(["child", "gh"]);
    });
  });

  // Defense-in-depth: getContent / path / getPath validate names before
  // composing on-disk paths. See SkillStore equivalent for rationale.
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

  // path() is a public method with no current caller in-repo, but as a
  // public surface it must not hand back a traversed filesystem path
  // either — otherwise a future caller inherits the same hole.
  // The Repository pattern moved path-composition into FsSkillRepository,
  // which validates names at every public method. The SkillStore.path()
  // surface was retired with no callers.
});
