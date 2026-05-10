import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FrontmatterError, HasDependents, NotFound } from "../errors.js";
import {
  applyFrontmatterPatch,
  depRefToFqn,
  frontmatterToSkill,
  parseFrontmatter,
  projectionOpts,
} from "../frontmatter.js";
import type { GraphNode } from "../graph.js";
import type { CatalogEntryFile, SkillRepository } from "../repositories/repository.js";
import type { DependencyRef, Skill } from "../types.js";
import { validateFqn } from "../validate.js";

export type SkillMetadataPatch = Partial<{
  description: string;
  version: string;
  prereqs: string | null;
  dependencies: { skills?: DependencyRef[]; mcps?: DependencyRef[] } | null;
}>;

/**
 * Per-call options for {@link SkillCatalog.install}.
 *
 * `origin` is propagated into the parsed Skill (and injected into the
 * SKILL.md COPY in the catalog if missing in the source). The route layer
 * passes `file:<absoluteSourceDir>` for local installs; the catalog-sources
 * fetchers pass the original remote URI.
 */
export interface InstallSkillOpts {
  readonly origin?: string;
}

/** Business-logic facade over a {@link SkillRepository}. See `AgentCatalog`. */
export class SkillCatalog {
  private readonly skills = new Map<string, Skill>();

  constructor(private readonly repository: SkillRepository) {}

  // ─── CRUD ───────────────────────────────────────────────

  async install(sourceDir: string, opts: InstallSkillOpts = {}): Promise<Skill> {
    const sourcePath = join(sourceDir, "SKILL.md");
    const original = await readFile(sourcePath, "utf8");
    const { data } = parseFrontmatter(original, sourcePath);
    const skill = frontmatterToSkill(data, sourcePath, projectionOpts(opts.origin));

    // installFromDir copies the entire source tree under the FQN; if the
    // source frontmatter omitted `origin`, follow up with a write() that
    // overwrites the SKILL.md COPY (in the catalog only — the user's source
    // file is never touched) so the entry is self-describing for future
    // scans without depending on the install-time defaultOrigin.
    await this.repository.installFromDir(skill.name, sourceDir);
    if (data.origin === undefined) {
      const rewritten = applyFrontmatterPatch(original, { origin: skill.origin });
      await this.repository.write(skill.name, rewritten);
    }
    this.skills.set(skill.name, skill);
    return skill;
  }

  /**
   * Stream-based install used by the pluggable-fetcher path. The stream is
   * fully buffered into memory so we can both parse SKILL.md (to derive the
   * FQN) and forward the bytes to {@link SkillRepository.install}. Skills
   * are tiny in practice (<100 KB anchor + small assets); a memory-buffered
   * shape is fine and avoids needing an on-disk staging directory in the
   * caller.
   */
  async installFromStream(
    stream: AsyncIterable<CatalogEntryFile>,
    opts: InstallSkillOpts = {},
    sourceLabel = "<stream>",
  ): Promise<Skill> {
    const buffered: CatalogEntryFile[] = [];
    let anchor: { content: string; sourcePath: string } | null = null;
    for await (const file of stream) {
      buffered.push(file);
      if (file.relPath === "SKILL.md") {
        anchor = {
          content: file.content.toString("utf8"),
          sourcePath: `${sourceLabel}/SKILL.md`,
        };
      }
    }
    if (!anchor) {
      throw new FrontmatterError(sourceLabel, "stream did not contain a top-level SKILL.md");
    }
    const { data } = parseFrontmatter(anchor.content, anchor.sourcePath);
    const skill = frontmatterToSkill(data, anchor.sourcePath, projectionOpts(opts.origin));

    // If origin is missing in source, rewrite the SKILL.md entry in the
    // buffered stream so the on-disk copy is self-describing — same
    // contract as installFromDir above.
    let toInstall: CatalogEntryFile[] = buffered;
    if (data.origin === undefined) {
      const rewritten = applyFrontmatterPatch(anchor.content, { origin: skill.origin });
      toInstall = buffered.map((f) =>
        f.relPath === "SKILL.md"
          ? { relPath: f.relPath, content: Buffer.from(rewritten, "utf8") }
          : f,
      );
    }
    await this.repository.install(skill.name, asyncIterableOf(toInstall));
    this.skills.set(skill.name, skill);
    return skill;
  }

  async getContent(name: string): Promise<string> {
    // Defense-in-depth: see AgentCatalog.getContent for rationale.
    validateFqn(name);
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    const content = await this.repository.read(name);
    if (content === null) throw new NotFound("skill", name);
    return content;
  }

  async updateContent(name: string, content: string): Promise<Skill> {
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    const sourcePath = `repository:skills/${name}/SKILL.md`;

    const { data } = parseFrontmatter(content, sourcePath);
    const existingSkill = this.skills.get(name);
    // Preserve the existing entry's origin when the patch omits one — the
    // user shouldn't have to retype it on every metadata edit.
    const skill = frontmatterToSkill(data, sourcePath, projectionOpts(existingSkill?.origin));
    if (skill.name !== name) {
      throw new FrontmatterError(
        sourcePath,
        `cannot rename via edit: frontmatter resolves to "${skill.name}" but entry is "${name}". Remove and re-install instead.`,
      );
    }

    await this.repository.write(name, content);
    this.skills.set(name, skill);
    return skill;
  }

  async updateMetadata(name: string, patch: SkillMetadataPatch): Promise<Skill> {
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    const sourcePath = `repository:skills/${name}/SKILL.md`;
    const existing = await this.repository.read(name);
    if (existing === null) throw new NotFound("skill", name);
    const existingSkill = this.skills.get(name);

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
          const obj: { skills?: readonly DependencyRef[]; mcps?: readonly DependencyRef[] } = {};
          if (skills.length > 0) obj.skills = skills;
          if (mcps.length > 0) obj.mcps = mcps;
          merge.dependencies = obj;
        }
      }
    }

    const newContent = applyFrontmatterPatch(existing, merge);

    const { data } = parseFrontmatter(newContent, sourcePath);
    const skill = frontmatterToSkill(data, sourcePath, projectionOpts(existingSkill?.origin));
    if (skill.name !== name) {
      throw new FrontmatterError(
        sourcePath,
        `metadata patch must not change identity (current="${name}", patched="${skill.name}")`,
      );
    }

    await this.repository.write(name, newContent);
    this.skills.set(name, skill);
    return skill;
  }

  async remove(name: string, getDependents: (name: string) => string[]): Promise<void> {
    validateFqn(name);
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
      dependencies: [
        ...(skill.dependencies?.skills ?? []).map((r) => depRefToFqn(r, "skill")),
        ...(skill.dependencies?.mcps ?? []).map((r) => depRefToFqn(r, "mcp")),
      ],
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
    validateFqn(name);
    if (!this.skills.has(name)) throw new NotFound("skill", name);
    return this.repository.entries(name);
  }
}

async function* asyncIterableOf<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) yield item;
}
