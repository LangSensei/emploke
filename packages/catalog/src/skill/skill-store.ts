import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplaceDir, pathExists } from "../atomic.js";
import { FrontmatterError, HasDependents, NotFound } from "../errors.js";
import { applyFrontmatterPatch, frontmatterToSkill, parseFrontmatter } from "../frontmatter.js";
import type { GraphNode } from "../graph.js";
import type { Skill } from "../types.js";
import { nameToPath, validateName } from "../validate.js";

export type SkillMetadataPatch = Partial<{
  description: string;
  version: string;
  prereqs: string | null;
  dependencies: { skills?: string[]; mcps?: string[] } | null;
}>;

export class SkillStore {
  private readonly skills = new Map<string, Skill>();

  constructor(private readonly catalogDir: string) {}

  private get baseDir() {
    return join(this.catalogDir, "skills");
  }

  // ─── CRUD ───────────────────────────────────────────────

  async install(sourceDir: string): Promise<Skill> {
    const skillMd = join(sourceDir, "SKILL.md");
    const content = await readFile(skillMd, "utf8");
    const { data } = parseFrontmatter(content, skillMd);
    const skill = frontmatterToSkill(data, skillMd);
    validateName(skill.name);

    const destDir = join(this.baseDir, nameToPath(skill.name));
    await atomicReplaceDir(sourceDir, destDir);
    this.skills.set(skill.name, skill);
    return skill;
  }

  async getContent(name: string): Promise<string> {
    // Defense-in-depth: validate the name before composing a path. Routes
    // already throw NameInvalid on install/remove, but `getContent` was the
    // one disk-touching method that trusted upstream validation. A malicious
    // or buggy caller passing a name with `/`, `..`, or `\` could compose a
    // path outside `baseDir`; rejecting at this boundary kills the class
    // of bug regardless of which layer above is responsible for hardening.
    validateName(name);
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    const skillMd = join(this.baseDir, nameToPath(name), "SKILL.md");
    return readFile(skillMd, "utf8");
  }

  /**
   * Replace the full SKILL.md content of an existing skill. The new
   * content's frontmatter must parse and the `name` field must equal the
   * existing name (renames go through remove + install).
   */
  async updateContent(name: string, content: string): Promise<Skill> {
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    const skillMd = join(this.baseDir, nameToPath(name), "SKILL.md");

    // Parse + validate before touching disk.
    const { data } = parseFrontmatter(content, skillMd);
    const skill = frontmatterToSkill(data, skillMd);
    if (skill.name !== name) {
      throw new FrontmatterError(
        skillMd,
        `cannot rename via edit: frontmatter name "${skill.name}" must equal "${name}". Remove and re-install instead.`,
      );
    }
    validateName(skill.name);

    await mkdir(join(this.baseDir, nameToPath(name)), { recursive: true });
    await writeFile(skillMd, content, "utf8");
    this.skills.set(name, skill);
    return skill;
  }

  /**
   * Patch the frontmatter metadata of an existing skill, preserving the
   * markdown body and any unknown frontmatter keys. Used by the dashboard's
   * form-mode editor.
   */
  async updateMetadata(name: string, patch: SkillMetadataPatch): Promise<Skill> {
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    const skillMd = join(this.baseDir, nameToPath(name), "SKILL.md");
    const existing = await readFile(skillMd, "utf8");

    // Build the merge object. `null` values explicitly remove the key.
    // Empty `dependencies` (no skills, no mcps) collapse to "remove key".
    const merge: Record<string, unknown> = {};
    if (patch.description !== undefined) merge.description = patch.description;
    if (patch.version !== undefined) merge.version = patch.version;
    if (patch.prereqs !== undefined) merge.prereqs = patch.prereqs;
    if (patch.dependencies !== undefined) {
      const d = patch.dependencies;
      if (d === null) {
        merge.dependencies = null;
      } else {
        const skills = d.skills ?? [];
        const mcps = d.mcps ?? [];
        if (skills.length === 0 && mcps.length === 0) {
          merge.dependencies = null;
        } else {
          const obj: { skills?: readonly string[]; mcps?: readonly string[] } = {};
          if (skills.length > 0) obj.skills = skills;
          if (mcps.length > 0) obj.mcps = mcps;
          merge.dependencies = obj;
        }
      }
    }

    const newContent = applyFrontmatterPatch(existing, merge);

    // Re-validate.
    const { data } = parseFrontmatter(newContent, skillMd);
    const skill = frontmatterToSkill(data, skillMd);
    if (skill.name !== name) {
      throw new FrontmatterError(
        skillMd,
        `metadata patch must not change name (current="${name}", patched="${skill.name}")`,
      );
    }

    await writeFile(skillMd, newContent, "utf8");
    this.skills.set(name, skill);
    return skill;
  }

  async remove(name: string, getDependents: (name: string) => string[]): Promise<void> {
    validateName(name);
    if (!this.skills.has(name)) throw new NotFound("skill", name);

    const dependents = getDependents(name);
    if (dependents.length > 0) throw new HasDependents(name, dependents);

    const destDir = join(this.baseDir, nameToPath(name));
    await rm(destDir, { recursive: true, force: true });
    this.skills.delete(name);
  }

  get(name: string): Skill | null {
    return this.skills.get(name) ?? null;
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  path(name: string): string {
    // Defense-in-depth: validate before composing a path. `path()` is a
    // public method on the store; even though no caller in this repo
    // currently uses it, hardening at the boundary protects future
    // consumers from inheriting the same path-traversal class of bug
    // that getContent had before 716edd6.
    validateName(name);
    return join(this.baseDir, nameToPath(name));
  }

  // ─── Graph ──────────────────────────────────────────────

  graphNodes(): GraphNode[] {
    return [...this.skills].map(([name, skill]) => ({
      name,
      dependencies: [...(skill.dependencies?.skills ?? []), ...(skill.dependencies?.mcps ?? [])],
    }));
  }

  // ─── Scan ──────────────────────────────────────────────

  async scan(): Promise<{ path: string; reason: string }[]> {
    this.skills.clear();
    const issues: { path: string; reason: string }[] = [];
    if (!(await pathExists(this.baseDir))) return issues;
    await this.scanDir(this.baseDir, null, issues);
    return issues;
  }

  private async scanDir(
    dir: string,
    scope: string | null,
    issues: { path: string; reason: string }[],
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(dir, entry.name);
      const skillMd = join(entryPath, "SKILL.md");

      if (await pathExists(skillMd)) {
        try {
          const content = await readFile(skillMd, "utf8");
          const { data } = parseFrontmatter(content, skillMd);
          const skill = frontmatterToSkill(data, skillMd);
          this.skills.set(skill.name, skill);
        } catch (e) {
          issues.push({ path: skillMd, reason: (e as Error).message });
        }
      } else if (scope === null) {
        await this.scanDir(entryPath, entry.name, issues);
      }
    }
  }
}
