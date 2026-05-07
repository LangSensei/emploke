import { mkdir as mkdirFs, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplaceDir, atomicWriteJsonFile, pathExists } from "./atomic.js";
import {
  CatalogStateError,
  HasDependents,
  MissingDependencies,
  NameConflict,
  NameInvalid,
  NotFound,
} from "./errors.js";
import { InMemoryEventBus } from "./event-bus.js";
import { frontmatterToSkill, parseFrontmatter } from "./frontmatter.js";
import { findDirectDependents, type GraphNode, resolveTopological } from "./graph.js";
import type {
  CatalogEvent,
  EventBus,
  McpInstalled,
  McpUninstalled,
  McpUpdated,
  ResolvedMcp,
  ResolvedSkill,
  Skill,
  SkillInstalled,
  SkillUninstalled,
  SkillUpdated,
} from "./types.js";
import { validateName } from "./validate.js";

/** A non-fatal problem encountered while scanning the catalog root. */
export interface ScanIssue {
  readonly path: string;
  readonly reason: string;
}

export interface CatalogOptions {
  /** Absolute path to the marketplace root. Layout is hard-coded:
   *    <root>/skills/<name>/SKILL.md
   *    <root>/mcps/<name>.json
   */
  readonly root: string;
}

/**
 * The only public class of @emploke/catalog.
 *
 * Lifecycle: construct via {@link Catalog.open} (which scans the root). After
 * that, the catalog mirrors the file system in memory until the next scan.
 *
 * Concurrency: all write operations acquire an exclusive file lock
 * (`<root>/.lock`) via flock. Multiple readers are always safe.
 *
 * Source of truth: the file system. The in-memory state is a cached
 * projection. Restarting the process (or constructing a fresh Catalog) yields
 * the same state from disk.
 */
export class Catalog {
  private readonly root: string;
  private readonly skills = new Map<string, Skill>();
  private readonly mcps = new Set<string>();
  private readonly _issues: ScanIssue[] = [];
  /** Public, externally subscribable event bus. */
  readonly events: EventBus<CatalogEvent> = new InMemoryEventBus<CatalogEvent>();

  private constructor(opts: CatalogOptions) {
    this.root = opts.root;
  }

  /** Open a catalog rooted at the given directory and scan its contents. */
  static async open(opts: CatalogOptions): Promise<Catalog> {
    const c = new Catalog(opts);
    await c.scan();
    return c;
  }

  /** Issues found during the most recent scan. Non-fatal entry-level problems. */
  get scanIssues(): readonly ScanIssue[] {
    return this._issues;
  }

  /** Re-scan the file system, replacing the in-memory projection. */
  async rescan(): Promise<void> {
    await this.scan();
  }

  // ─── Write lock (flock) ──────────────────────────────────────────────

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockDir = join(this.root, ".lock");
    // mkdir is atomic on POSIX — exactly one caller wins.
    // Retry briefly in case another async operation holds the lock.
    const maxRetries = 50;
    const retryMs = 20;
    let acquired = false;
    for (let i = 0; i < maxRetries; i++) {
      try {
        await mkdirFs(lockDir, { recursive: false });
        acquired = true;
        break;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
    if (!acquired) {
      throw new CatalogStateError("could not acquire write lock (timeout)");
    }
    try {
      return await fn();
    } finally {
      await rmdir(lockDir).catch(() => {});
    }
  }

  // ─── Path helpers ───────────────────────────────────────────────────

  private skillsDir(): string {
    return join(this.root, "skills");
  }

  private mcpsDir(): string {
    return join(this.root, "mcps");
  }

  private skillDir(name: string): string {
    return join(this.skillsDir(), name);
  }

  private mcpFile(name: string): string {
    return join(this.mcpsDir(), `${name}.json`);
  }

  // ─── Scan ──────────────────────────────────────────────────────────

  private async scan(): Promise<void> {
    this.skills.clear();
    this.mcps.clear();
    this._issues.length = 0;
    await this.scanSkills();
    await this.scanMcps();
  }

  private async scanSkills(): Promise<void> {
    if (!(await pathExists(this.skillsDir()))) return;
    const entries = await readdir(this.skillsDir(), { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".")) continue; // skip temp/backup dirs
      const file = join(this.skillsDir(), ent.name, "SKILL.md");
      try {
        const content = await readFile(file, "utf8");
        const { data } = parseFrontmatter(content, file);
        const skill = frontmatterToSkill(data, file);
        if (skill.name !== ent.name) {
          this._issues.push({
            path: file,
            reason: `frontmatter name "${skill.name}" does not match folder name "${ent.name}"`,
          });
          continue;
        }
        try {
          validateName(skill.name);
        } catch (e) {
          this._issues.push({ path: file, reason: (e as Error).message });
          continue;
        }
        if (this.skills.has(skill.name) || this.mcps.has(skill.name)) {
          this._issues.push({ path: file, reason: `duplicate name "${skill.name}"` });
          continue;
        }
        this.skills.set(skill.name, skill);
      } catch (e) {
        this._issues.push({ path: file, reason: (e as Error).message });
      }
    }
  }

  private async scanMcps(): Promise<void> {
    if (!(await pathExists(this.mcpsDir()))) return;
    const entries = await readdir(this.mcpsDir(), { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".json")) continue;
      if (ent.name.startsWith(".")) continue;
      const name = ent.name.slice(0, -".json".length);
      const filePath = join(this.mcpsDir(), ent.name);
      try {
        validateName(name);
      } catch (e) {
        this._issues.push({ path: filePath, reason: (e as Error).message });
        continue;
      }
      if (this.skills.has(name) || this.mcps.has(name)) {
        this._issues.push({ path: filePath, reason: `duplicate name "${name}"` });
        continue;
      }
      this.mcps.add(name);
    }
  }

  // ─── Read API ──────────────────────────────────────────────────────

  async listSkills(filter?: { type?: string }): Promise<readonly Skill[]> {
    const out: Skill[] = [];
    for (const s of this.skills.values()) {
      if (filter?.type !== undefined && s.type !== filter.type) continue;
      out.push(s);
    }
    return out;
  }

  async listMcps(): Promise<readonly ResolvedMcp[]> {
    const out: ResolvedMcp[] = [];
    for (const name of this.mcps) {
      out.push({ name, path: this.mcpFile(name) });
    }
    return out;
  }

  async getSkill(name: string): Promise<ResolvedSkill> {
    const skill = this.skills.get(name);
    if (!skill) throw new NotFound("skill", name);
    return { skill, path: this.skillDir(name) };
  }

  async getMcp(name: string): Promise<ResolvedMcp> {
    if (!this.mcps.has(name)) throw new NotFound("mcp", name);
    return { name, path: this.mcpFile(name) };
  }

  async dependents(name: string): Promise<readonly Skill[]> {
    const out: Skill[] = [];
    for (const s of this.skills.values()) {
      const deps = [...(s.dependencies?.skills ?? []), ...(s.dependencies?.mcps ?? [])];
      if (deps.includes(name)) out.push(s);
    }
    return out;
  }

  async resolveSkill(name: string): Promise<{
    root: ResolvedSkill;
    transitiveSkills: readonly ResolvedSkill[];
    transitiveMcps: readonly ResolvedMcp[];
  }> {
    if (!this.skills.has(name)) throw new NotFound("skill", name);

    const order = resolveTopological([name], (n) => this.adaptNode(n));

    const transitiveSkills: ResolvedSkill[] = [];
    const transitiveMcps: ResolvedMcp[] = [];
    for (const node of order) {
      if (node.kind === "skill") {
        transitiveSkills.push({ skill: node.skill, path: this.skillDir(node.name) });
      } else {
        transitiveMcps.push({ name: node.name, path: this.mcpFile(node.name) });
      }
    }

    const rootResolved = transitiveSkills.find((r) => r.skill.name === name);
    if (!rootResolved) {
      // Defensive: resolveTopological always emits the start node when no error.
      throw new CatalogStateError(`internal: root "${name}" missing from topological result`);
    }
    return { root: rootResolved, transitiveSkills, transitiveMcps };
  }

  // ─── Write API: skills ─────────────────────────────────────────────

  async installSkill(cmd: { sourceDir: string }): Promise<SkillInstalled> {
    return this.withWriteLock(async () => {
      const skill = await this.parseSkillSource(cmd.sourceDir);
      const { name } = skill;
      if (this.skills.has(name) || this.mcps.has(name)) {
        throw new NameConflict(name);
      }
      this.checkAllDepsExist(skill);

      // Speculatively install in memory for cycle check, rollback on any failure.
      this.skills.set(name, skill);
      try {
        resolveTopological([name], (n) => this.adaptNode(n));
        await atomicReplaceDir(cmd.sourceDir, this.skillDir(name));
      } catch (e) {
        this.skills.delete(name);
        throw e;
      }

      const event: SkillInstalled = {
        type: "SkillInstalled",
        name,
        path: this.skillDir(name),
        at: new Date(),
      };
      this.events.publish(event);
      return event;
    });
  }

  async updateSkill(cmd: { name: string; sourceDir: string }): Promise<SkillUpdated> {
    return this.withWriteLock(async () => {
      validateName(cmd.name);
      const previous = this.skills.get(cmd.name);
      if (!previous) throw new NotFound("skill", cmd.name);

      const skill = await this.parseSkillSource(cmd.sourceDir);
      if (skill.name !== cmd.name) {
        throw new NameInvalid(
          skill.name,
          `update target is "${cmd.name}" but source frontmatter declares "${skill.name}"; rename via update is not supported`,
        );
      }

      // Speculatively swap in for graph checks.
      this.skills.set(skill.name, skill);
      try {
        this.checkAllDepsExist(skill);
        resolveTopological([skill.name], (n) => this.adaptNode(n));
        await atomicReplaceDir(cmd.sourceDir, this.skillDir(skill.name));
      } catch (e) {
        this.skills.set(cmd.name, previous);
        throw e;
      }

      const event: SkillUpdated = {
        type: "SkillUpdated",
        name: skill.name,
        path: this.skillDir(skill.name),
        at: new Date(),
      };
      this.events.publish(event);
      return event;
    });
  }

  async uninstallSkill(name: string): Promise<SkillUninstalled> {
    return this.withWriteLock(async () => {
      validateName(name);
      if (!this.skills.has(name)) throw new NotFound("skill", name);
      const dependents = findDirectDependents(name, this.adaptedAll());
      if (dependents.length > 0) {
        throw new HasDependents(
          name,
          dependents.map((d) => d.name),
        );
      }
      await rm(this.skillDir(name), { recursive: true, force: true });
      this.skills.delete(name);
      const event: SkillUninstalled = { type: "SkillUninstalled", name, at: new Date() };
      this.events.publish(event);
      return event;
    });
  }

  // ─── Write API: MCPs ───────────────────────────────────────────────

  async installMcp(cmd: { name: string; json: unknown }): Promise<McpInstalled> {
    return this.withWriteLock(async () => {
      validateName(cmd.name);
      if (this.skills.has(cmd.name) || this.mcps.has(cmd.name)) {
        throw new NameConflict(cmd.name);
      }
      await atomicWriteJsonFile(cmd.json, this.mcpFile(cmd.name));
      this.mcps.add(cmd.name);
      const event: McpInstalled = {
        type: "McpInstalled",
        name: cmd.name,
        path: this.mcpFile(cmd.name),
        at: new Date(),
      };
      this.events.publish(event);
      return event;
    });
  }

  async updateMcp(cmd: { name: string; json: unknown }): Promise<McpUpdated> {
    return this.withWriteLock(async () => {
      validateName(cmd.name);
      if (!this.mcps.has(cmd.name)) throw new NotFound("mcp", cmd.name);
      await atomicWriteJsonFile(cmd.json, this.mcpFile(cmd.name));
      const event: McpUpdated = {
        type: "McpUpdated",
        name: cmd.name,
        path: this.mcpFile(cmd.name),
        at: new Date(),
      };
      this.events.publish(event);
      return event;
    });
  }

  async uninstallMcp(name: string): Promise<McpUninstalled> {
    return this.withWriteLock(async () => {
      validateName(name);
      if (!this.mcps.has(name)) throw new NotFound("mcp", name);
      const dependents = findDirectDependents(name, this.adaptedAll());
      if (dependents.length > 0) {
        throw new HasDependents(
          name,
          dependents.map((d) => d.name),
        );
      }
      await rm(this.mcpFile(name), { force: true });
      this.mcps.delete(name);
      const event: McpUninstalled = { type: "McpUninstalled", name, at: new Date() };
      this.events.publish(event);
      return event;
    });
  }

  // ─── Internal helpers ──────────────────────────────────────────────

  private async parseSkillSource(sourceDir: string): Promise<Skill> {
    const file = join(sourceDir, "SKILL.md");
    if (!(await pathExists(file))) {
      throw new NameInvalid(sourceDir, `SKILL.md not found at ${file}`);
    }
    const content = await readFile(file, "utf8");
    const { data } = parseFrontmatter(content, file);
    const skill = frontmatterToSkill(data, file);
    validateName(skill.name);
    return skill;
  }

  private checkAllDepsExist(skill: Skill): void {
    const skillDeps = skill.dependencies?.skills ?? [];
    const mcpDeps = skill.dependencies?.mcps ?? [];
    const missing: string[] = [];
    for (const d of skillDeps) {
      if (!this.skills.has(d)) missing.push(d);
    }
    for (const d of mcpDeps) {
      if (!this.mcps.has(d)) missing.push(d);
    }
    if (missing.length > 0) throw new MissingDependencies(missing);
  }

  private adaptNode(name: string): TaggedNode | undefined {
    const skill = this.skills.get(name);
    if (skill) {
      const dependencies = [
        ...(skill.dependencies?.skills ?? []),
        ...(skill.dependencies?.mcps ?? []),
      ];
      return { kind: "skill", name, dependencies, skill };
    }
    if (this.mcps.has(name)) {
      return { kind: "mcp", name, dependencies: [] };
    }
    return undefined;
  }

  private *adaptedAll(): Iterable<GraphNode> {
    for (const s of this.skills.values()) {
      yield {
        name: s.name,
        dependencies: [...(s.dependencies?.skills ?? []), ...(s.dependencies?.mcps ?? [])],
      };
    }
    for (const name of this.mcps) {
      yield { name, dependencies: [] };
    }
  }
}

type TaggedNode =
  | {
      readonly kind: "skill";
      readonly name: string;
      readonly dependencies: readonly string[];
      readonly skill: Skill;
    }
  | {
      readonly kind: "mcp";
      readonly name: string;
      readonly dependencies: readonly string[];
    };
