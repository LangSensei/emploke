import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── Main entities ──────────────────────────────────────────

export const agents = sqliteTable(
  "agents",
  {
    fqn: text("fqn").primaryKey(),
    origin: text("origin").notNull(),
    description: text("description").notNull(),
    version: text("version").notNull(),
    prereqs: text("prereqs"),
    prereqsAck: integer("prereqs_ack").notNull().default(1),
    disabledByUser: integer("disabled_by_user").notNull().default(0),
    installedAt: text("installed_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("agents_origin").on(t.origin), index("agents_updated_at").on(t.updatedAt)],
);

export const skills = sqliteTable(
  "skills",
  {
    fqn: text("fqn").primaryKey(),
    origin: text("origin").notNull(),
    description: text("description").notNull(),
    version: text("version").notNull(),
    prereqs: text("prereqs"),
    prereqsAck: integer("prereqs_ack").notNull().default(1),
    installedAt: text("installed_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("skills_origin").on(t.origin), index("skills_updated_at").on(t.updatedAt)],
);

export const mcps = sqliteTable(
  "mcps",
  {
    fqn: text("fqn").primaryKey(),
    origin: text("origin").notNull(),
    spec: text("spec").notNull(),
    installedAt: text("installed_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("mcps_origin").on(t.origin), index("mcps_updated_at").on(t.updatedAt)],
);

// ─── File-blob tables ───────────────────────────────────────

export const agentFiles = sqliteTable(
  "agent_files",
  {
    rowId: integer("row_id").primaryKey({ autoIncrement: true }),
    agentFqn: text("agent_fqn").notNull(),
    relPath: text("rel_path").notNull(),
    content: blob("content", { mode: "buffer" }).notNull(),
  },
  (t) => [index("agent_files_agent_fqn_idx").on(t.agentFqn)],
);

export const skillFiles = sqliteTable(
  "skill_files",
  {
    rowId: integer("row_id").primaryKey({ autoIncrement: true }),
    skillFqn: text("skill_fqn").notNull(),
    relPath: text("rel_path").notNull(),
    content: blob("content", { mode: "buffer" }).notNull(),
  },
  (t) => [index("skill_files_skill_fqn_idx").on(t.skillFqn)],
);

// ─── Dependency tables ──────────────────────────────────────

export const agentSkillDeps = sqliteTable(
  "agent_skill_dependencies",
  {
    rowId: integer("row_id").primaryKey({ autoIncrement: true }),
    sourceFqn: text("source_fqn").notNull(),
    targetFqn: text("target_fqn").notNull(),
  },
  (t) => [
    index("agent_skill_deps_src_idx").on(t.sourceFqn),
    index("agent_skill_deps_tgt_idx").on(t.targetFqn),
    uniqueIndex("agent_skill_deps_uniq").on(t.sourceFqn, t.targetFqn),
  ],
);

export const agentMcpDeps = sqliteTable(
  "agent_mcp_dependencies",
  {
    rowId: integer("row_id").primaryKey({ autoIncrement: true }),
    sourceFqn: text("source_fqn").notNull(),
    targetFqn: text("target_fqn").notNull(),
  },
  (t) => [
    index("agent_mcp_deps_src_idx").on(t.sourceFqn),
    index("agent_mcp_deps_tgt_idx").on(t.targetFqn),
    uniqueIndex("agent_mcp_deps_uniq").on(t.sourceFqn, t.targetFqn),
  ],
);

export const skillSkillDeps = sqliteTable(
  "skill_skill_dependencies",
  {
    rowId: integer("row_id").primaryKey({ autoIncrement: true }),
    sourceFqn: text("source_fqn").notNull(),
    targetFqn: text("target_fqn").notNull(),
  },
  (t) => [
    index("skill_skill_deps_src_idx").on(t.sourceFqn),
    index("skill_skill_deps_tgt_idx").on(t.targetFqn),
    uniqueIndex("skill_skill_deps_uniq").on(t.sourceFqn, t.targetFqn),
  ],
);

export const skillMcpDeps = sqliteTable(
  "skill_mcp_dependencies",
  {
    rowId: integer("row_id").primaryKey({ autoIncrement: true }),
    sourceFqn: text("source_fqn").notNull(),
    targetFqn: text("target_fqn").notNull(),
  },
  (t) => [
    index("skill_mcp_deps_src_idx").on(t.sourceFqn),
    index("skill_mcp_deps_tgt_idx").on(t.targetFqn),
    uniqueIndex("skill_mcp_deps_uniq").on(t.sourceFqn, t.targetFqn),
  ],
);
