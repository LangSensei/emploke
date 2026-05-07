import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.js";
import {
  CycleDetected,
  HasDependents,
  MissingDependencies,
  NameConflict,
  NameInvalid,
  NotFound,
} from "../src/errors.js";
import type { CatalogEvent } from "../src/types.js";

/**
 * Integration tests for {@link Catalog}.
 *
 * These tests deliberately run against the real filesystem (tempdir) — no
 * mocking. They are the authoritative spec of catalog behaviour.
 */

interface Frontmatter {
  name: string;
  description: string;
  version?: string;
  type?: string;
  dependencies?: { skills?: string[]; mcps?: string[] };
  // Pass-through fields emploke must preserve untouched on disk:
  prereq?: string;
  license?: string;
}

/** Quote a YAML scalar to force string type (handles numeric or empty values). */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build a SKILL.md source dir under `workDir` with the given frontmatter and body. */
async function makeSkillSource(
  workDir: string,
  fm: Frontmatter,
  body = "# body\n",
): Promise<string> {
  const dir = join(workDir, `src-${fm.name}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  const yamlLines: string[] = ["---"];
  yamlLines.push(`name: ${fm.name}`);
  yamlLines.push(`description: ${yamlQuote(fm.description)}`);
  if (fm.version !== undefined) yamlLines.push(`version: ${yamlQuote(fm.version)}`);
  if (fm.type !== undefined) yamlLines.push(`type: ${fm.type}`);
  if (fm.prereq !== undefined) yamlLines.push(`prereq: ${fm.prereq}`);
  if (fm.license !== undefined) yamlLines.push(`license: ${fm.license}`);
  if (fm.dependencies !== undefined) {
    yamlLines.push(`dependencies:`);
    if (fm.dependencies.skills) {
      yamlLines.push(`  skills:`);
      for (const s of fm.dependencies.skills) yamlLines.push(`    - ${s}`);
    }
    if (fm.dependencies.mcps) {
      yamlLines.push(`  mcps:`);
      for (const m of fm.dependencies.mcps) yamlLines.push(`    - ${m}`);
    }
  }
  yamlLines.push("---");
  await writeFile(join(dir, "SKILL.md"), `${yamlLines.join("\n")}\n${body}`, "utf8");
  return dir;
}

describe("Catalog (integration)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "emploke-catalog-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("open + scan", () => {
    it("opens an empty root with no skills, no mcps, no issues", async () => {
      const c = await Catalog.open({ catalogDir: root });
      expect(await c.listSkills()).toEqual([]);
      expect(await c.listMcps()).toEqual([]);
      expect(c.scanIssues).toEqual([]);
    });

    it("scans existing skills and mcps from disk", async () => {
      // pre-seed disk with a skill and an mcp
      await mkdir(join(root, "skills", "git-pr"), { recursive: true });
      await writeFile(
        join(root, "skills", "git-pr", "SKILL.md"),
        "---\nname: git-pr\ndescription: open prs\nversion: 1.0.0\n---\n",
        "utf8",
      );
      await mkdir(join(root, "mcps"), { recursive: true });
      await writeFile(
        join(root, "mcps", "swat.json"),
        JSON.stringify({ type: "stdio", command: "swat" }),
        "utf8",
      );

      const c = await Catalog.open({ catalogDir: root });
      const skills = await c.listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({ name: "git-pr", version: "1.0.0" });
      const mcps = await c.listMcps();
      expect(mcps).toHaveLength(1);
      expect(mcps[0]?.name).toBe("swat");
      expect(c.scanIssues).toEqual([]);
    });

    it("records issue when folder name does not match frontmatter name", async () => {
      await mkdir(join(root, "skills", "wrong-folder"), { recursive: true });
      await writeFile(
        join(root, "skills", "wrong-folder", "SKILL.md"),
        "---\nname: actual-name\ndescription: x\n---\n",
        "utf8",
      );
      const c = await Catalog.open({ catalogDir: root });
      expect(await c.listSkills()).toEqual([]);
      expect(c.scanIssues).toHaveLength(1);
      expect(c.scanIssues[0]?.reason).toMatch(/does not match folder name/);
    });

    it("records issue and skips bad SKILL.md, keeps good ones", async () => {
      await mkdir(join(root, "skills", "good"), { recursive: true });
      await writeFile(
        join(root, "skills", "good", "SKILL.md"),
        "---\nname: good\ndescription: g\n---\n",
        "utf8",
      );
      await mkdir(join(root, "skills", "bad"), { recursive: true });
      await writeFile(join(root, "skills", "bad", "SKILL.md"), "not yaml", "utf8");

      const c = await Catalog.open({ catalogDir: root });
      const skills = await c.listSkills();
      expect(skills.map((s) => s.name)).toEqual(["good"]);
      expect(c.scanIssues).toHaveLength(1);
    });

    it("ignores hidden temp/backup directories", async () => {
      await mkdir(join(root, "skills", ".something.tmp.abc"), { recursive: true });
      const c = await Catalog.open({ catalogDir: root });
      expect(await c.listSkills()).toEqual([]);
      expect(c.scanIssues).toEqual([]);
    });
  });

  describe("installSkill", () => {
    it("installs a leaf skill (no deps)", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const src = await makeSkillSource(root, { name: "sop", description: "method" });

      const event = await c.installSkill({ sourceDir: src });

      expect(event.type).toBe("SkillInstalled");
      expect(event.name).toBe("sop");
      const list = await c.listSkills();
      expect(list).toHaveLength(1);
      const resolved = await c.getSkill("sop");
      expect(resolved.path).toBe(join(root, "skills", "sop"));
      // SKILL.md exists on disk
      const fileContent = await readFile(join(resolved.path, "SKILL.md"), "utf8");
      expect(fileContent).toContain("name: sop");
    });

    it("preserves un-interpreted frontmatter fields on disk", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const src = await makeSkillSource(root, {
        name: "git-pr",
        description: "x",
        prereq: "references/SETUP.md",
        license: "MIT",
      });

      await c.installSkill({ sourceDir: src });

      const onDisk = await readFile(join(root, "skills", "git-pr", "SKILL.md"), "utf8");
      expect(onDisk).toContain("prereq: references/SETUP.md");
      expect(onDisk).toContain("license: MIT");
      // emploke does not surface these in Skill type
      const skill = (await c.listSkills())[0];
      expect(skill).not.toHaveProperty("prereq");
      expect(skill).not.toHaveProperty("license");
    });

    it("fills version 0.0.1 when frontmatter omits it (memory only, file unchanged)", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const src = await makeSkillSource(root, { name: "anth", description: "x" });

      await c.installSkill({ sourceDir: src });

      const skill = (await c.listSkills())[0];
      expect(skill?.version).toBe("0.0.1");
      // file does not contain version field
      const onDisk = await readFile(join(root, "skills", "anth", "SKILL.md"), "utf8");
      expect(onDisk).not.toContain("version:");
    });

    it("rejects install when name already exists as skill", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const src1 = await makeSkillSource(root, { name: "x", description: "1" });
      await c.installSkill({ sourceDir: src1 });
      const src2 = await makeSkillSource(root, { name: "x", description: "2" });

      await expect(c.installSkill({ sourceDir: src2 })).rejects.toThrow(NameConflict);
    });

    it("rejects install when name already exists as mcp", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installMcp({ name: "shared-name", json: { type: "stdio", command: "x" } });
      const src = await makeSkillSource(root, { name: "shared-name", description: "x" });

      await expect(c.installSkill({ sourceDir: src })).rejects.toThrow(NameConflict);
    });

    it("rejects install when dependency does not exist", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const src = await makeSkillSource(root, {
        name: "needs",
        description: "x",
        dependencies: { skills: ["missing"] },
      });

      try {
        await c.installSkill({ sourceDir: src });
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(MissingDependencies);
        expect((e as MissingDependencies).missing).toEqual(["missing"]);
      }
      // and not committed
      expect(await c.listSkills()).toEqual([]);
    });

    it("rejects self-dependency", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const src = await makeSkillSource(root, {
        name: "selfish",
        description: "x",
        dependencies: { skills: ["selfish"] },
      });
      // self-dep on install: name not yet in catalog → MissingDependencies
      await expect(c.installSkill({ sourceDir: src })).rejects.toThrow(MissingDependencies);
    });

    it("rejects invalid name (not kebab-case)", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const src = await makeSkillSource(root, { name: "Bad_Name", description: "x" });
      await expect(c.installSkill({ sourceDir: src })).rejects.toThrow(NameInvalid);
    });

    it("emits SkillInstalled event", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const events: CatalogEvent[] = [];
      c.events.subscribe((e) => events.push(e));
      const src = await makeSkillSource(root, { name: "evt", description: "x" });
      await c.installSkill({ sourceDir: src });
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("SkillInstalled");
    });
  });

  describe("installMcp", () => {
    it("installs an mcp from a JSON object", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const event = await c.installMcp({
        name: "playwright",
        json: { type: "stdio", command: "npx" },
      });
      expect(event.type).toBe("McpInstalled");
      const mcps = await c.listMcps();
      expect(mcps).toHaveLength(1);
      // file exists with serialized JSON
      const content = await readFile(join(root, "mcps", "playwright.json"), "utf8");
      expect(JSON.parse(content)).toEqual({ type: "stdio", command: "npx" });
    });

    it("emploke does not validate json content", async () => {
      const c = await Catalog.open({ catalogDir: root });
      // arbitrary nonsense — emploke writes it as-is
      await c.installMcp({ name: "weird", json: { whatever: 42, nope: null } });
      const content = await readFile(join(root, "mcps", "weird.json"), "utf8");
      expect(JSON.parse(content)).toEqual({ whatever: 42, nope: null });
    });

    it("rejects name conflict with existing skill", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const src = await makeSkillSource(root, { name: "shared", description: "x" });
      await c.installSkill({ sourceDir: src });
      await expect(
        c.installMcp({ name: "shared", json: { type: "stdio", command: "x" } }),
      ).rejects.toThrow(NameConflict);
    });

    it("rejects invalid name", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await expect(
        c.installMcp({ name: "BAD", json: { type: "stdio", command: "x" } }),
      ).rejects.toThrow(NameInvalid);
    });
  });

  describe("resolveSkill", () => {
    it("returns root with no transitive deps when leaf", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, { name: "leaf", description: "x" }),
      });

      const r = await c.resolveSkill("leaf");
      expect(r.root.skill.name).toBe("leaf");
      expect(r.transitiveSkills.map((s) => s.skill.name)).toEqual(["leaf"]);
      expect(r.transitiveMcps).toEqual([]);
    });

    it("returns deps in topological order (deps before dependents)", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, { name: "base", description: "x" }),
      });
      await c.installMcp({ name: "tool", json: { type: "stdio", command: "x" } });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, {
          name: "top",
          description: "x",
          dependencies: { skills: ["base"], mcps: ["tool"] },
        }),
      });

      const r = await c.resolveSkill("top");
      expect(r.transitiveSkills.map((s) => s.skill.name)).toEqual(["base", "top"]);
      expect(r.transitiveMcps.map((m) => m.name)).toEqual(["tool"]);
      expect(r.root.skill.name).toBe("top");
      expect(r.root.path).toBe(join(root, "skills", "top"));
    });

    it("throws NotFound when skill does not exist", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await expect(c.resolveSkill("ghost")).rejects.toThrow(NotFound);
    });
  });

  describe("updateSkill", () => {
    it("replaces files on disk and updates in-memory skill", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, {
          name: "u",
          description: "v1",
          version: "1.0.0",
        }),
      });

      const newSrc = await makeSkillSource(root, {
        name: "u",
        description: "v2",
        version: "2.0.0",
      });
      const event = await c.updateSkill({ name: "u", sourceDir: newSrc });

      expect(event.type).toBe("SkillUpdated");
      const skill = await c.getSkill("u");
      expect(skill.skill.description).toBe("v2");
      expect(skill.skill.version).toBe("2.0.0");
    });

    it("rejects rename via update", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, { name: "orig", description: "x" }),
      });
      const renamed = await makeSkillSource(root, { name: "renamed", description: "x" });
      await expect(c.updateSkill({ name: "orig", sourceDir: renamed })).rejects.toThrow(
        NameInvalid,
      );
    });

    it("rejects update introducing a cycle", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, { name: "a", description: "x" }),
      });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, {
          name: "b",
          description: "x",
          dependencies: { skills: ["a"] },
        }),
      });
      // Now make a depend on b → cycle
      const newA = await makeSkillSource(root, {
        name: "a",
        description: "x",
        dependencies: { skills: ["b"] },
      });
      await expect(c.updateSkill({ name: "a", sourceDir: newA })).rejects.toThrow(CycleDetected);
      // Original still resolvable — rollback worked
      const skillA = await c.getSkill("a");
      expect(skillA.skill.dependencies).toBeUndefined();
    });

    it("throws NotFound when updating missing skill", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const src = await makeSkillSource(root, { name: "ghost", description: "x" });
      await expect(c.updateSkill({ name: "ghost", sourceDir: src })).rejects.toThrow(NotFound);
    });
  });

  describe("uninstallSkill", () => {
    it("removes from disk and memory", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, { name: "rm", description: "x" }),
      });
      const event = await c.uninstallSkill("rm");
      expect(event.type).toBe("SkillUninstalled");
      expect(await c.listSkills()).toEqual([]);
      const { stat } = await import("node:fs/promises");
      await expect(stat(join(root, "skills", "rm"))).rejects.toThrow();
    });

    it("blocks uninstall when something still depends on it", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, { name: "lib", description: "x" }),
      });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, {
          name: "user",
          description: "x",
          dependencies: { skills: ["lib"] },
        }),
      });
      try {
        await c.uninstallSkill("lib");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(HasDependents);
        expect((e as HasDependents).dependents).toEqual(["user"]);
      }
    });

    it("throws NotFound for missing skill", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await expect(c.uninstallSkill("ghost")).rejects.toThrow(NotFound);
    });
  });

  describe("uninstallMcp", () => {
    it("removes from disk and memory", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installMcp({ name: "tmp", json: { type: "stdio", command: "x" } });
      await c.uninstallMcp("tmp");
      expect(await c.listMcps()).toEqual([]);
    });

    it("blocks uninstall when a skill depends on it", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installMcp({ name: "tool", json: { type: "stdio", command: "x" } });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, {
          name: "user",
          description: "x",
          dependencies: { mcps: ["tool"] },
        }),
      });
      await expect(c.uninstallMcp("tool")).rejects.toThrow(HasDependents);
    });
  });

  describe("dependents", () => {
    it("lists direct dependents only", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, { name: "base", description: "x" }),
      });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, {
          name: "mid",
          description: "x",
          dependencies: { skills: ["base"] },
        }),
      });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, {
          name: "top",
          description: "x",
          dependencies: { skills: ["mid"] },
        }),
      });

      const deps = await c.dependents("base");
      expect(deps.map((d) => d.name)).toEqual(["mid"]); // only direct, not "top"
    });
  });

  describe("listSkills with type filter", () => {
    it("filters by type", async () => {
      const c = await Catalog.open({ catalogDir: root });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, {
          name: "a",
          description: "x",
          type: "skill",
        }),
      });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, {
          name: "b",
          description: "x",
          type: "squad",
        }),
      });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, { name: "c", description: "x" }),
      });
      expect((await c.listSkills({ type: "skill" })).map((s) => s.name)).toEqual(["a"]);
      expect((await c.listSkills({ type: "squad" })).map((s) => s.name)).toEqual(["b"]);
      expect((await c.listSkills()).map((s) => s.name).sort()).toEqual(["a", "b", "c"]);
    });
  });

  describe("event subscription", () => {
    it("emits events for all write operations", async () => {
      const c = await Catalog.open({ catalogDir: root });
      const events: CatalogEvent[] = [];
      c.events.subscribe((e) => events.push(e));

      await c.installMcp({ name: "m", json: { type: "stdio", command: "x" } });
      await c.installSkill({
        sourceDir: await makeSkillSource(root, {
          name: "s",
          description: "x",
          dependencies: { mcps: ["m"] },
        }),
      });
      await c.updateSkill({
        name: "s",
        sourceDir: await makeSkillSource(root, {
          name: "s",
          description: "y",
          dependencies: { mcps: ["m"] },
        }),
      });
      await c.updateMcp({ name: "m", json: { type: "stdio", command: "y" } });
      await c.uninstallSkill("s");
      await c.uninstallMcp("m");

      expect(events.map((e) => e.type)).toEqual([
        "McpInstalled",
        "SkillInstalled",
        "SkillUpdated",
        "McpUpdated",
        "SkillUninstalled",
        "McpUninstalled",
      ]);
    });
  });

  describe("rescan", () => {
    it("picks up changes made directly to the file system", async () => {
      const c = await Catalog.open({ catalogDir: root });
      expect(await c.listSkills()).toEqual([]);

      // External writer drops a skill folder
      await mkdir(join(root, "skills", "ext"), { recursive: true });
      await writeFile(
        join(root, "skills", "ext", "SKILL.md"),
        "---\nname: ext\ndescription: external\n---\n",
        "utf8",
      );

      await c.rescan();
      expect((await c.listSkills()).map((s) => s.name)).toEqual(["ext"]);
    });
  });
});
