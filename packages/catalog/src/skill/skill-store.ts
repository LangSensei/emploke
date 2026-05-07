import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplaceDir, pathExists } from "../atomic.js";
import { HasDependents, NotFound } from "../errors.js";
import { frontmatterToSkill, parseFrontmatter } from "../frontmatter.js";
import type { GraphNode } from "../graph.js";
import type { CatalogEvent, EventBus, Skill } from "../types.js";
import { nameToPath, validateName } from "../validate.js";

export class SkillStore {
  private readonly skills = new Map<string, Skill>();

  constructor(
    private readonly catalogDir: string,
    private readonly events: EventBus<CatalogEvent>,
  ) {}

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
    const exists = this.skills.has(skill.name);
    await atomicReplaceDir(sourceDir, destDir);
    this.skills.set(skill.name, skill);

    this.events.publish({
      type: exists ? "SkillUpdated" : "SkillInstalled",
      name: skill.name,
      path: destDir,
      at: new Date(),
    });
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
    this.events.publish({ type: "SkillUninstalled", name, at: new Date() });
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
