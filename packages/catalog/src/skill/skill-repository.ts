import { and, count, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import { emptyDeps } from "../_shared/dep-keys.js";
import { nowIso } from "../_shared/entity-helpers.js";
import {
  aggregateDepsForFqn,
  coerceToBuffer,
  dedupedDepEdges,
  groupDepRowsBySource,
} from "../_shared/repo-helpers.js";
import type { AnchoredFile } from "../_shared/service-helpers.js";
import type * as schema from "../schema.js";
import { agentSkillDeps, skillFiles, skillMcpDeps, skillSkillDeps, skills } from "../schema.js";
import { SkillNotFoundError } from "./errors.js";
import { type SkillDependencies, SkillEntity } from "./skill-entity.js";
import { SKILL_DEP_SPECS, type SkillDepKind } from "./skill-frontmatter.js";

const silentLogger: Logger = pino({ level: "silent" });

/** One file inside a skill, as yielded by {@link SkillRepository.streamFiles}. */
export type SkillFile = AnchoredFile;

export interface SkillRepoAddDeps {
  readonly skills: readonly string[];
  readonly mcps: readonly string[];
}

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed `SkillRepository`. Multi-table writes are wrapped in
 * `db.transaction(...)` so the row + files + dep rows commit atomically.
 *
 * Composition: this class wires the skill-specific drizzle tables; the
 * cross-kind plumbing (dep dedupe, blob coercion, dep-rows aggregation)
 * comes from `_shared/repo-helpers.ts`. No inheritance.
 */
export class SkillRepository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
  }

  close(): void {
    // intentionally empty — `compose.ts` owns the sqlite handle lifecycle
  }

  async add(
    skill: SkillEntity,
    files: ReadonlyMap<string, Buffer>,
    deps: SkillRepoAddDeps,
  ): Promise<void> {
    if (!files.has("SKILL.md")) {
      throw new TypeError(
        `SkillRepository.add requires SKILL.md in the files map (got: ${[...files.keys()].join(", ")})`,
      );
    }
    const now = nowIso();
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
        tx.insert(skillFiles).values({ skillFqn: skill.fqn, relPath, content }).run();
      }
      tx.delete(skillSkillDeps).where(eq(skillSkillDeps.sourceFqn, skill.fqn)).run();
      tx.delete(skillMcpDeps).where(eq(skillMcpDeps.sourceFqn, skill.fqn)).run();
      for (const edge of dedupedDepEdges(SKILL_DEP_SPECS, deps, skill.fqn)) {
        if (edge.kind === "skills") {
          tx.insert(skillSkillDeps)
            .values({ sourceFqn: skill.fqn, targetFqn: edge.targetFqn })
            .run();
        } else {
          tx.insert(skillMcpDeps).values({ sourceFqn: skill.fqn, targetFqn: edge.targetFqn }).run();
        }
      }
    });
  }

  async findByFqn(fqn: string): Promise<SkillEntity | null> {
    const row = this.db.select().from(skills).where(eq(skills.fqn, fqn)).get();
    if (row === undefined) return null;
    const deps = await this.listDependencies(fqn);
    return rowToSkill(row, deps);
  }

  async findByOrigin(origin: string): Promise<SkillEntity | null> {
    const row = this.db.select().from(skills).where(eq(skills.origin, origin)).get();
    if (row === undefined) return null;
    const deps = await this.listDependencies(row.fqn);
    return rowToSkill(row, deps);
  }

  async findAll(): Promise<SkillEntity[]> {
    const rows = this.db.select().from(skills).orderBy(skills.fqn).all();
    const depsByFqn = this.loadAllDeps();
    const out: SkillEntity[] = [];
    for (const row of rows) {
      try {
        const deps = depsByFqn.get(row.fqn) ?? emptyDeps(SKILL_DEP_SPECS);
        out.push(rowToSkill(row, deps));
      } catch (cause) {
        this.logger.warn(
          { fqn: row.fqn ?? null, err: cause },
          "catalog/skill: skipping row that failed validation",
        );
      }
    }
    return out;
  }

  async delete(fqn: string): Promise<void> {
    // Race-free: count + delete in one transaction so a concurrent
    // `installSkill` / `installAgent` that adds a dep on this skill
    // can't slip between our count check and the row removal. The
    // synthetic `SQLITE_CONSTRAINT_FOREIGNKEY` thrown inside the
    // transaction rolls back the empty delete and propagates.
    this.db.transaction((tx) => {
      const skillDepCount =
        tx
          .select({ c: count() })
          .from(skillSkillDeps)
          .where(eq(skillSkillDeps.targetFqn, fqn))
          .get()?.c ?? 0;
      const agentDepCount =
        tx
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
      tx.delete(skillFiles).where(eq(skillFiles.skillFqn, fqn)).run();
      tx.delete(skillSkillDeps).where(eq(skillSkillDeps.sourceFqn, fqn)).run();
      tx.delete(skillMcpDeps).where(eq(skillMcpDeps.sourceFqn, fqn)).run();
      tx.delete(skills).where(eq(skills.fqn, fqn)).run();
    });
  }

  async *streamFiles(fqn: string): AsyncIterable<SkillFile> {
    const rows = this.db.select().from(skillFiles).where(eq(skillFiles.skillFqn, fqn)).all();
    for (const row of rows) {
      yield { relPath: row.relPath, content: coerceToBuffer(row.content) };
    }
  }

  async getAnchor(fqn: string): Promise<string> {
    const row = this.db
      .select()
      .from(skillFiles)
      .where(and(eq(skillFiles.skillFqn, fqn), eq(skillFiles.relPath, "SKILL.md")))
      .get();
    if (row === undefined) throw new SkillNotFoundError(fqn);
    return coerceToBuffer(row.content).toString("utf8");
  }

  async listDependencies(fqn: string): Promise<SkillDependencies> {
    const skillRows = this.db
      .select({ targetFqn: skillSkillDeps.targetFqn })
      .from(skillSkillDeps)
      .where(eq(skillSkillDeps.sourceFqn, fqn))
      .orderBy(skillSkillDeps.targetFqn)
      .all();
    const mcpRows = this.db
      .select({ targetFqn: skillMcpDeps.targetFqn })
      .from(skillMcpDeps)
      .where(eq(skillMcpDeps.sourceFqn, fqn))
      .orderBy(skillMcpDeps.targetFqn)
      .all();
    return aggregateDepsForFqn<SkillDepKind>(SKILL_DEP_SPECS, {
      skills: skillRows,
      mcps: mcpRows,
    });
  }

  async findDependentAgents(targetFqn: string): Promise<string[]> {
    const rows = this.db
      .select({ sourceFqn: agentSkillDeps.sourceFqn })
      .from(agentSkillDeps)
      .where(eq(agentSkillDeps.targetFqn, targetFqn))
      .orderBy(agentSkillDeps.sourceFqn)
      .all();
    return rows.map((r) => r.sourceFqn);
  }

  async findDependentSkills(targetFqn: string): Promise<string[]> {
    const rows = this.db
      .select({ sourceFqn: skillSkillDeps.sourceFqn })
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
      .set({ prereqsAck: flags.prereqsAck ? 1 : 0, updatedAt: nowIso() })
      .where(eq(skills.fqn, fqn))
      .run();
  }

  private loadAllDeps(): Map<string, SkillDependencies> {
    const skillRows = this.db
      .select({
        sourceFqn: skillSkillDeps.sourceFqn,
        targetFqn: skillSkillDeps.targetFqn,
      })
      .from(skillSkillDeps)
      .orderBy(skillSkillDeps.sourceFqn, skillSkillDeps.targetFqn)
      .all();
    const mcpRows = this.db
      .select({
        sourceFqn: skillMcpDeps.sourceFqn,
        targetFqn: skillMcpDeps.targetFqn,
      })
      .from(skillMcpDeps)
      .orderBy(skillMcpDeps.sourceFqn, skillMcpDeps.targetFqn)
      .all();
    return groupDepRowsBySource<SkillDepKind>(SKILL_DEP_SPECS, {
      skills: skillRows,
      mcps: mcpRows,
    });
  }
}

function rowToSkill(row: typeof skills.$inferSelect, deps: SkillDependencies): SkillEntity {
  return SkillEntity.fromStored({
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
