import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import { emptyDeps } from "../_shared/dep-keys.js";
import { HasDependentsError } from "../_shared/dependents-error.js";
import type * as schema from "../schema.js";
import { agentSkillDeps, skillFiles, skillMcpDeps, skillSkillDeps, skills } from "../schema.js";
import { SkillNotFoundError } from "./errors.js";
import { type SkillDependencies, SkillEntity } from "./skill-entity.js";
import { SKILL_DEP_SPECS } from "./skill-frontmatter.js";

const silentLogger: Logger = pino({ level: "silent" });

/** One file inside a skill, as yielded by {@link SkillRepository.streamFiles}. */
export interface SkillFile {
  readonly relPath: string;
  readonly content: Buffer;
}

export interface SkillRepoAddDeps {
  readonly skills: readonly string[];
  readonly mcps: readonly string[];
}

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed `SkillRepository`. Multi-table writes are wrapped in
 * `db.transaction(...)` so the row + files + dep rows commit atomically.
 *
 * Owned entirely by `skill/` per the decoupling-over-abstraction axiom.
 * Dep dedupe, blob coercion, and dep-rows aggregation are inlined per
 * kind (see {@link toBuf}, the `add`'s skipSelf-dedupe loop, and
 * {@link loadAllDeps}) — no shared helper module. Agent mirrors the
 * same shape by intent.
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
        tx.insert(skillFiles).values({ skillFqn: skill.fqn, relPath, content }).run();
      }
      tx.delete(skillSkillDeps).where(eq(skillSkillDeps.sourceFqn, skill.fqn)).run();
      tx.delete(skillMcpDeps).where(eq(skillMcpDeps.sourceFqn, skill.fqn)).run();
      // Per-kind dedupe + skipSelf-apply, fanned out to the typed
      // dep tables. `skipSelf: true` on the `skills` bucket silently
      // drops a self-edge (a typo, not a cycle to honour).
      for (const spec of SKILL_DEP_SPECS) {
        const list = (spec.kind === "skills" ? deps.skills : deps.mcps) ?? [];
        const seen = new Set<string>();
        for (const targetFqn of list) {
          if (spec.skipSelf === true && targetFqn === skill.fqn) continue;
          if (seen.has(targetFqn)) continue;
          seen.add(targetFqn);
          if (spec.kind === "skills") {
            tx.insert(skillSkillDeps).values({ sourceFqn: skill.fqn, targetFqn }).run();
          } else {
            tx.insert(skillMcpDeps).values({ sourceFqn: skill.fqn, targetFqn }).run();
          }
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
    // Race-free: collect dependents + delete in one transaction so a
    // concurrent `installSkill` / `installAgent` that adds a dep on
    // this skill can't slip between our check and the row removal.
    // Stands in for missing FK constraints. Throwing
    // `HasDependentsError` inside the transaction rolls back the empty
    // delete and propagates to the caller.
    this.db.transaction((tx) => {
      const skillDeps = tx
        .select({ sourceFqn: skillSkillDeps.sourceFqn })
        .from(skillSkillDeps)
        .where(eq(skillSkillDeps.targetFqn, fqn))
        .orderBy(skillSkillDeps.sourceFqn)
        .all();
      const agentDeps = tx
        .select({ sourceFqn: agentSkillDeps.sourceFqn })
        .from(agentSkillDeps)
        .where(eq(agentSkillDeps.targetFqn, fqn))
        .orderBy(agentSkillDeps.sourceFqn)
        .all();
      if (skillDeps.length + agentDeps.length > 0) {
        throw new HasDependentsError(fqn, [
          ...skillDeps.map((r) => ({ kind: "skill" as const, name: r.sourceFqn })),
          ...agentDeps.map((r) => ({ kind: "agent" as const, name: r.sourceFqn })),
        ]);
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
      yield { relPath: row.relPath, content: toBuf(row.content) };
    }
  }

  async getAnchor(fqn: string): Promise<string> {
    const row = this.db
      .select()
      .from(skillFiles)
      .where(and(eq(skillFiles.skillFqn, fqn), eq(skillFiles.relPath, "SKILL.md")))
      .get();
    if (row === undefined) throw new SkillNotFoundError(fqn);
    return toBuf(row.content).toString("utf8");
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
    return {
      skills: skillRows.map((r) => ({ fqn: r.targetFqn })),
      mcps: mcpRows.map((r) => ({ fqn: r.targetFqn })),
    };
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
      .set({ prereqsAck: flags.prereqsAck ? 1 : 0, updatedAt: new Date().toISOString() })
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
    // Aggregate flat dep rows into `Map<sourceFqn, SkillDependencies>`.
    // Per-kind inlining (groupBy-style) — the only shared module is
    // `_shared/dep-keys.ts` which names no skill-specific concept.
    // Both source lists are already ordered by (sourceFqn, targetFqn),
    // so the per-source arrays stay sorted.
    const out = new Map<string, { skills: { fqn: string }[]; mcps: { fqn: string }[] }>();
    function ensure(sourceFqn: string): { skills: { fqn: string }[]; mcps: { fqn: string }[] } {
      const existing = out.get(sourceFqn);
      if (existing !== undefined) return existing;
      const fresh = { skills: [] as { fqn: string }[], mcps: [] as { fqn: string }[] };
      out.set(sourceFqn, fresh);
      return fresh;
    }
    for (const r of skillRows) ensure(r.sourceFqn).skills.push({ fqn: r.targetFqn });
    for (const r of mcpRows) ensure(r.sourceFqn).mcps.push({ fqn: r.targetFqn });
    return out as Map<string, SkillDependencies>;
  }
}

/** Normalise the drizzle blob shape — `better-sqlite3` may surface `Uint8Array`. */
function toBuf(content: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
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
