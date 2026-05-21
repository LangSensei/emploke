import { and, eq, count } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { type Logger, silentLogger } from "@emploke/logger";
import {
  agentSkillDeps,
  skillFiles,
  skillMcpDeps,
  skills,
  skillSkillDeps,
} from "../schema.js";
import type * as schema from "../schema.js";
import { SkillNotFoundError } from "./errors.js";
import { Skill, type SkillDependencies } from "./skill-entity.js";
import type { SkillFile, SkillRepoAddDeps, SkillRepository } from "./skill-repository.js";

type Db = BetterSQLite3Database<typeof schema>;

export class DrizzleSkillRepository implements SkillRepository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
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
    this.db.transaction((tx) => {
      const existing = tx
        .select({ fqn: skills.fqn })
        .from(skills)
        .where(eq(skills.fqn, skill.fqn))
        .get();
      const baseFields = {
        origin: skill.origin,
        description: skill.description,
        version: skill.version,
        prereqs: skill.prereqs ?? null,
        prereqsAck: skill.prereqsAck ? 1 : 0,
        updatedAt: now,
      };
      if (existing !== undefined) {
        tx.update(skills).set(baseFields).where(eq(skills.fqn, skill.fqn)).run();
      } else {
        tx.insert(skills)
          .values({ fqn: skill.fqn, installedAt: now, ...baseFields })
          .run();
      }
      tx.delete(skillFiles).where(eq(skillFiles.skillFqn, skill.fqn)).run();
      for (const [relPath, content] of files) {
        tx.insert(skillFiles)
          .values({ skillFqn: skill.fqn, relPath, content })
          .run();
      }
      tx.delete(skillSkillDeps).where(eq(skillSkillDeps.sourceFqn, skill.fqn)).run();
      tx.delete(skillMcpDeps).where(eq(skillMcpDeps.sourceFqn, skill.fqn)).run();
      const seenSkill = new Set<string>();
      for (const targetFqn of deps.skills) {
        if (targetFqn === skill.fqn) continue;
        if (seenSkill.has(targetFqn)) continue;
        seenSkill.add(targetFqn);
        tx.insert(skillSkillDeps).values({ sourceFqn: skill.fqn, targetFqn }).run();
      }
      const seenMcp = new Set<string>();
      for (const targetFqn of deps.mcps) {
        if (seenMcp.has(targetFqn)) continue;
        seenMcp.add(targetFqn);
        tx.insert(skillMcpDeps).values({ sourceFqn: skill.fqn, targetFqn }).run();
      }
    });
  }

  async findByFqn(fqn: string): Promise<Skill | null> {
    const row = this.db.select().from(skills).where(eq(skills.fqn, fqn)).get();
    if (row === undefined) return null;
    const deps = await this.listDependencies(fqn);
    return rowToSkill(row, deps);
  }

  async findByOrigin(origin: string): Promise<Skill | null> {
    const row = this.db.select().from(skills).where(eq(skills.origin, origin)).get();
    if (row === undefined) return null;
    const deps = await this.listDependencies(row.fqn);
    return rowToSkill(row, deps);
  }

  async findAll(): Promise<Skill[]> {
    const rows = this.db.select().from(skills).orderBy(skills.fqn).all();
    const depsByFqn = this.loadAllDeps();
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
    const skillDepCount =
      this.db
        .select({ c: count() })
        .from(skillSkillDeps)
        .where(eq(skillSkillDeps.targetFqn, fqn))
        .get()?.c ?? 0;
    const agentDepCount =
      this.db
        .select({ c: count() })
        .from(agentSkillDeps)
        .where(eq(agentSkillDeps.targetFqn, fqn))
        .get()?.c ?? 0;
    if (skillDepCount + agentDepCount > 0) {
      const e = new Error(
        `FOREIGN KEY constraint failed: ${skillDepCount + agentDepCount} dependent(s) reference ${fqn}`,
      );
      (e as Error & { code: string }).code = "SQLITE_CONSTRAINT_FOREIGNKEY";
      throw e;
    }
    this.db.transaction((tx) => {
      tx.delete(skillFiles).where(eq(skillFiles.skillFqn, fqn)).run();
      tx.delete(skillSkillDeps).where(eq(skillSkillDeps.sourceFqn, fqn)).run();
      tx.delete(skillMcpDeps).where(eq(skillMcpDeps.sourceFqn, fqn)).run();
      tx.delete(skills).where(eq(skills.fqn, fqn)).run();
    });
  }

  async *streamFiles(fqn: string): AsyncIterable<SkillFile> {
    const rows = this.db.select().from(skillFiles).where(eq(skillFiles.skillFqn, fqn)).all();
    for (const row of rows) {
      yield {
        relPath: row.relPath,
        content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content as Uint8Array),
      };
    }
  }

  async getAnchor(fqn: string): Promise<string> {
    const row = this.db
      .select()
      .from(skillFiles)
      .where(and(eq(skillFiles.skillFqn, fqn), eq(skillFiles.relPath, "SKILL.md")))
      .get();
    if (row === undefined) throw new SkillNotFoundError(fqn);
    const buf = Buffer.isBuffer(row.content)
      ? row.content
      : Buffer.from(row.content as Uint8Array);
    return buf.toString("utf8");
  }

  async listDependencies(fqn: string): Promise<SkillDependencies> {
    const skillRows = this.db
      .select()
      .from(skillSkillDeps)
      .where(eq(skillSkillDeps.sourceFqn, fqn))
      .orderBy(skillSkillDeps.targetFqn)
      .all();
    const mcpRows = this.db
      .select()
      .from(skillMcpDeps)
      .where(eq(skillMcpDeps.sourceFqn, fqn))
      .orderBy(skillMcpDeps.targetFqn)
      .all();
    return {
      skills: skillRows.map((r) => ({ fqn: r.targetFqn })),
      mcps: mcpRows.map((r) => ({ fqn: r.targetFqn })),
    };
  }

  async findDependentAgents(targetFqn: string): Promise<string[]> {
    const rows = this.db
      .select()
      .from(agentSkillDeps)
      .where(eq(agentSkillDeps.targetFqn, targetFqn))
      .orderBy(agentSkillDeps.sourceFqn)
      .all();
    return rows.map((r) => r.sourceFqn);
  }

  async findDependentSkills(targetFqn: string): Promise<string[]> {
    const rows = this.db
      .select()
      .from(skillSkillDeps)
      .where(eq(skillSkillDeps.targetFqn, targetFqn))
      .orderBy(skillSkillDeps.sourceFqn)
      .all();
    return rows.map((r) => r.sourceFqn);
  }

  async setFlags(fqn: string, flags: { prereqsAck?: boolean }): Promise<void> {
    if (flags.prereqsAck === undefined) return;
    this.db
      .update(skills)
      .set({ prereqsAck: flags.prereqsAck ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(eq(skills.fqn, fqn))
      .run();
  }

  private loadAllDeps(): Map<string, SkillDependencies> {
    const out = new Map<string, SkillDependencies>();
    const skillRows = this.db
      .select()
      .from(skillSkillDeps)
      .orderBy(skillSkillDeps.sourceFqn, skillSkillDeps.targetFqn)
      .all();
    const mcpRows = this.db
      .select()
      .from(skillMcpDeps)
      .orderBy(skillMcpDeps.sourceFqn, skillMcpDeps.targetFqn)
      .all();
    for (const r of skillRows) {
      const e = out.get(r.sourceFqn) ?? { skills: [], mcps: [] };
      out.set(r.sourceFqn, { skills: [...e.skills, { fqn: r.targetFqn }], mcps: e.mcps });
    }
    for (const r of mcpRows) {
      const e = out.get(r.sourceFqn) ?? { skills: [], mcps: [] };
      out.set(r.sourceFqn, { skills: e.skills, mcps: [...e.mcps, { fqn: r.targetFqn }] });
    }
    return out;
  }
}

function rowToSkill(
  row: typeof skills.$inferSelect,
  deps: SkillDependencies,
): Skill {
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
