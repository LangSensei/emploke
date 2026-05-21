import type { EntityManager } from "@mikro-orm/core";
import { type Logger, silentLogger } from "@emploke/logger";
import {
  AgentSkillDepRow,
  SkillFileRow,
  SkillMcpDepRow,
  SkillRow as SkillRowEntity,
  SkillSkillDepRow,
} from "../entity.js";
import { SkillNotFoundError } from "./errors.js";
import { Skill, type SkillDependencies } from "./skill-entity.js";
import type { SkillFile, SkillRepoAddDeps, SkillRepository } from "./skill-repository.js";

export class MikroSkillRepository implements SkillRepository {
  private readonly em: EntityManager;
  private readonly logger: Logger;

  constructor(opts: { em: EntityManager; logger?: Logger }) {
    this.em = opts.em;
    this.logger = opts.logger ?? silentLogger;
  }

  close(): void {
    // intentionally empty
  }

  async add(
    skill: Skill,
    files: ReadonlyMap<string, Buffer>,
    deps: SkillRepoAddDeps,
  ): Promise<void> {
    if (!files.has("SKILL.md")) {
      throw new TypeError(
        `SkillRepository.add requires SKILL.md in the files map (got: ${[...files.keys()].join(", ")})`,
      );
    }
    const now = new Date().toISOString();
    await this.em.transactional(async (em) => {
      em.clear();
      const existing = await em.findOne(SkillRowEntity, { fqn: skill.fqn });
      if (existing !== null) {
        Object.assign(existing, {
          origin: skill.origin,
          description: skill.description,
          version: skill.version,
          prereqs: skill.prereqs ?? null,
          prereqsAck: skill.prereqsAck ? 1 : 0,
          updatedAt: now,
        });
        em.persist(existing);
      } else {
        em.persist(
          em.create(SkillRowEntity, {
            fqn: skill.fqn,
            origin: skill.origin,
            description: skill.description,
            version: skill.version,
            prereqs: skill.prereqs ?? null,
            prereqsAck: skill.prereqsAck ? 1 : 0,
            installedAt: now,
            updatedAt: now,
          }),
        );
      }
      await em.nativeDelete(SkillFileRow, { skillFqn: skill.fqn });
      for (const [relPath, content] of files) {
        const sf = new SkillFileRow(); sf.skillFqn = skill.fqn; sf.relPath = relPath; sf.content = content; em.persist(sf);
      }
      await em.nativeDelete(SkillSkillDepRow, { sourceFqn: skill.fqn });
      await em.nativeDelete(SkillMcpDepRow, { sourceFqn: skill.fqn });
      const seenSkill = new Set<string>();
      for (const targetFqn of deps.skills) {
        if (targetFqn === skill.fqn) continue;
        if (seenSkill.has(targetFqn)) continue;
        seenSkill.add(targetFqn);
        const ssd = new SkillSkillDepRow(); ssd.sourceFqn = skill.fqn; ssd.targetFqn = targetFqn; em.persist(ssd);
      }
      const seenMcp = new Set<string>();
      for (const targetFqn of deps.mcps) {
        if (seenMcp.has(targetFqn)) continue;
        seenMcp.add(targetFqn);
        const smd = new SkillMcpDepRow(); smd.sourceFqn = skill.fqn; smd.targetFqn = targetFqn; em.persist(smd);
      }
    });
  }

  async findByFqn(fqn: string): Promise<Skill | null> {
    const row = await this.em.fork().findOne(SkillRowEntity, { fqn });
    if (row === null) return null;
    const deps = await this.listDependencies(fqn);
    return rowToSkill(row, deps);
  }

  async findByOrigin(origin: string): Promise<Skill | null> {
    const row = await this.em.fork().findOne(SkillRowEntity, { origin });
    if (row === null) return null;
    const deps = await this.listDependencies(row.fqn);
    return rowToSkill(row, deps);
  }

  async findAll(): Promise<Skill[]> {
    const em = this.em.fork();
    const rows = await em.find(SkillRowEntity, {}, { orderBy: { fqn: "asc" } });
    const depsByFqn = await this.loadAllDeps(em);
    const out: Skill[] = [];
    for (const row of rows) {
      try {
        const deps = depsByFqn.get(row.fqn) ?? { skills: [], mcps: [] };
        out.push(rowToSkill(row, deps));
      } catch (cause) {
        this.logger.warn(
          { fqn: row.fqn ?? null, cause: (cause as Error).message },
          "catalog/skill: skipping row that failed validation",
        );
      }
    }
    return out;
  }

  async delete(fqn: string): Promise<void> {
    // Replicate the old FK ON DELETE RESTRICT behaviour: refuse if any
    // sibling skill or agent still references this skill. The facade
    // catches this and rethrows as HasDependentsError.
    const em = this.em.fork();
    const skillDeps = await em.count(SkillSkillDepRow, { targetFqn: fqn });
    const agentDeps = await em.count(AgentSkillDepRow, { targetFqn: fqn });
    if (skillDeps + agentDeps > 0) {
      const e = new Error(
        `FOREIGN KEY constraint failed: ${skillDeps + agentDeps} dependent(s) reference ${fqn}`,
      );
      (e as Error & { code: string }).code = "SQLITE_CONSTRAINT_FOREIGNKEY";
      throw e;
    }
    await this.em.transactional(async (txEm) => {
      await txEm.nativeDelete(SkillFileRow, { skillFqn: fqn });
      await txEm.nativeDelete(SkillSkillDepRow, { sourceFqn: fqn });
      await txEm.nativeDelete(SkillMcpDepRow, { sourceFqn: fqn });
      await txEm.nativeDelete(SkillRowEntity, { fqn });
    });
  }

  async *streamFiles(fqn: string): AsyncIterable<SkillFile> {
    const rows = await this.em.fork().find(SkillFileRow, { skillFqn: fqn });
    for (const row of rows) {
      yield {
        relPath: row.relPath,
        content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content),
      };
    }
  }

  async getAnchor(fqn: string): Promise<string> {
    const row = await this.em.fork().findOne(SkillFileRow, { skillFqn: fqn, relPath: "SKILL.md" });
    if (row === null) throw new SkillNotFoundError(fqn);
    const buf = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    return buf.toString("utf8");
  }

  async listDependencies(fqn: string): Promise<SkillDependencies> {
    const em = this.em.fork();
    const skillRows = await em.find(
      SkillSkillDepRow,
      { sourceFqn: fqn },
      { orderBy: { targetFqn: "asc" } },
    );
    const mcpRows = await em.find(
      SkillMcpDepRow,
      { sourceFqn: fqn },
      { orderBy: { targetFqn: "asc" } },
    );
    return {
      skills: skillRows.map((r) => ({ fqn: r.targetFqn })),
      mcps: mcpRows.map((r) => ({ fqn: r.targetFqn })),
    };
  }

  async findDependentAgents(targetFqn: string): Promise<string[]> {
    const rows = await this.em
      .fork()
      .find(AgentSkillDepRow, { targetFqn }, { orderBy: { sourceFqn: "asc" } });
    return rows.map((r) => r.sourceFqn);
  }

  async findDependentSkills(targetFqn: string): Promise<string[]> {
    const rows = await this.em
      .fork()
      .find(SkillSkillDepRow, { targetFqn }, { orderBy: { sourceFqn: "asc" } });
    return rows.map((r) => r.sourceFqn);
  }

  async setFlags(fqn: string, flags: { prereqsAck?: boolean }): Promise<void> {
    if (flags.prereqsAck === undefined) return;
    await this.em.fork().nativeUpdate(
      SkillRowEntity,
      { fqn },
      { prereqsAck: flags.prereqsAck ? 1 : 0, updatedAt: new Date().toISOString() },
    );
  }

  private async loadAllDeps(em: EntityManager): Promise<Map<string, SkillDependencies>> {
    const out = new Map<string, SkillDependencies>();
    const skillRows = await em.find(
      SkillSkillDepRow,
      {},
      { orderBy: { sourceFqn: "asc", targetFqn: "asc" } },
    );
    const mcpRows = await em.find(
      SkillMcpDepRow,
      {},
      { orderBy: { sourceFqn: "asc", targetFqn: "asc" } },
    );
    for (const r of skillRows) {
      const e = out.get(r.sourceFqn) ?? { skills: [], mcps: [] };
      out.set(r.sourceFqn, {
        skills: [...e.skills, { fqn: r.targetFqn }],
        mcps: e.mcps,
      });
    }
    for (const r of mcpRows) {
      const e = out.get(r.sourceFqn) ?? { skills: [], mcps: [] };
      out.set(r.sourceFqn, {
        skills: e.skills,
        mcps: [...e.mcps, { fqn: r.targetFqn }],
      });
    }
    return out;
  }
}

function rowToSkill(row: SkillRowEntity, deps: SkillDependencies): Skill {
  return Skill.fromStored({
    fqn: row.fqn,
    origin: row.origin,
    description: row.description,
    version: row.version,
    prereqs: row.prereqs ?? undefined,
    dependencies: deps,
    prereqsAck: row.prereqsAck !== 0,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
  });
}
