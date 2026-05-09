import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FrontmatterError, HasDependents, NotFound } from "../errors.js";
import { applyFrontmatterPatch, frontmatterToSkill, parseFrontmatter } from "../frontmatter.js";
import type { GraphNode } from "../graph.js";
import type { CatalogEntryFile, SkillRepository } from "../repositories/repository.js";
import type { Skill } from "../types.js";
import { validateName } from "../validate.js";

export type SkillMetadataPatch = Partial<{
  description: string;
  version: string;
  prereqs: string | null;
  dependencies: { skills?: string[]; mcps?: string[] } | null;
}>;

/** Business-logic facade over a {@link SkillRepository}. See `AgentCatalog`. */
export class SkillCatalog {
  private readonly skills = new Map<string, Skill>();

  constructor(private readonly repository: SkillRepository) {}

  // ─── CRUD ───────────────────────────────────────────────

  async install(sourceDir: string): Promise<Skill> {
    const sourcePath = join(sourceDir, "SKILL.md");
    const content = await readFile(sourcePath, "utf8");
    const { data } = parseFrontmatter(content, sourcePath);
    const skill = frontmatterToSkill(data, sourcePath);
    validateName(skill.name);

    await this.repository.installFromDir(skill.name, sourceDir);
    this.skills.set(skill.name, skill);
    return skill;
  }

  async getContent(name: string): Promise<string> {
    // Defense-in-depth: see AgentCatalog.getContent for rationale.
    validateName(name);
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    const content = await this.repository.read(name);
    if (content === null) throw new NotFound("skill", name);
    return content;
  }

  async updateContent(name: string, content: string): Promise<Skill> {
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    const sourcePath = `repository:skills/${name}/SKILL.md`;

    const { data } = parseFrontmatter(content, sourcePath);
    const skill = frontmatterToSkill(data, sourcePath);
    if (skill.name !== name) {
      throw new FrontmatterError(
        sourcePath,
        `cannot rename via edit: frontmatter name "${skill.name}" must equal "${name}". Remove and re-install instead.`,
      );
    }
    validateName(skill.name);

    await this.repository.write(name, content);
    this.skills.set(name, skill);
    return skill;
  }

  async updateMetadata(name: string, patch: SkillMetadataPatch): Promise<Skill> {
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    const sourcePath = `repository:skills/${name}/SKILL.md`;
    const existing = await this.repository.read(name);
    if (existing === null) throw new NotFound("skill", name);

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

    const { data } = parseFrontmatter(newContent, sourcePath);
    const skill = frontmatterToSkill(data, sourcePath);
    if (skill.name !== name) {
      throw new FrontmatterError(
        sourcePath,
        `metadata patch must not change name (current="${name}", patched="${skill.name}")`,
      );
    }

    await this.repository.write(name, newContent);
    this.skills.set(name, skill);
    return skill;
  }

  async remove(name: string, getDependents: (name: string) => string[]): Promise<void> {
    validateName(name);
    if (!this.skills.has(name)) throw new NotFound("skill", name);

    const dependents = getDependents(name);
    if (dependents.length > 0) throw new HasDependents(name, dependents);

    await this.repository.delete(name);
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
    const entries = await this.repository.scan();
    for (const { content, sourcePath } of entries) {
      try {
        const { data } = parseFrontmatter(content, sourcePath);
        const skill = frontmatterToSkill(data, sourcePath);
        this.skills.set(skill.name, skill);
      } catch (e) {
        issues.push({ path: sourcePath, reason: (e as Error).message });
      }
    }
    return issues;
  }

  /** Stream every file of `name`. Throws NotFound if absent. */
  entries(name: string): AsyncIterable<CatalogEntryFile> {
    validateName(name);
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    return this.repository.entries(name);
  }
}
