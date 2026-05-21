import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

// ─── Main entities ──────────────────────────────────────────

@Entity({ tableName: "agents" })
export class AgentRow {
  @PrimaryKey({ type: "text" })
  fqn!: string;

  @Property({ type: "text" })
  @Index({ name: "agents_origin" })
  origin!: string;

  @Property({ type: "text" })
  description!: string;

  @Property({ type: "text" })
  version!: string;

  @Property({ type: "text", nullable: true })
  prereqs!: string | null;

  @Property({ type: "integer", fieldName: "prereqs_ack", default: 1 })
  prereqsAck!: number;

  @Property({ type: "integer", fieldName: "disabled_by_user", default: 0 })
  disabledByUser!: number;

  @Property({ type: "text", fieldName: "installed_at" })
  installedAt!: string;

  @Property({ type: "text", fieldName: "updated_at" })
  @Index({ name: "agents_updated_at" })
  updatedAt!: string;
}

@Entity({ tableName: "skills" })
export class SkillRow {
  @PrimaryKey({ type: "text" })
  fqn!: string;

  @Property({ type: "text" })
  @Index({ name: "skills_origin" })
  origin!: string;

  @Property({ type: "text" })
  description!: string;

  @Property({ type: "text" })
  version!: string;

  @Property({ type: "text", nullable: true })
  prereqs!: string | null;

  @Property({ type: "integer", fieldName: "prereqs_ack", default: 1 })
  prereqsAck!: number;

  @Property({ type: "text", fieldName: "installed_at" })
  installedAt!: string;

  @Property({ type: "text", fieldName: "updated_at" })
  @Index({ name: "skills_updated_at" })
  updatedAt!: string;
}

@Entity({ tableName: "mcps" })
export class McpRow {
  @PrimaryKey({ type: "text" })
  fqn!: string;

  @Property({ type: "text" })
  @Index({ name: "mcps_origin" })
  origin!: string;

  @Property({ type: "text" })
  spec!: string;

  @Property({ type: "text", fieldName: "installed_at" })
  installedAt!: string;

  @Property({ type: "text", fieldName: "updated_at" })
  @Index({ name: "mcps_updated_at" })
  updatedAt!: string;
}

// ─── File-blob tables ───────────────────────────────────────
// MikroORM doesn't natively support composite-primary-key entities the
// same way it does single-PK, but for this use case (insert + select +
// delete-by-parent) we model them as entities with composite indexes.

@Entity({ tableName: "agent_files" })
export class AgentFileRow {
  @PrimaryKey({ type: "integer", autoincrement: true })
  rowId!: number;

  @Property({ type: "text", fieldName: "agent_fqn" })
  @Index({ name: "agent_files_agent_fqn_idx" })
  agentFqn!: string;

  @Property({ type: "text", fieldName: "rel_path" })
  relPath!: string;

  @Property({ type: "blob" })
  content!: Buffer;
}

@Entity({ tableName: "skill_files" })
export class SkillFileRow {
  @PrimaryKey({ type: "integer", autoincrement: true })
  rowId!: number;

  @Property({ type: "text", fieldName: "skill_fqn" })
  @Index({ name: "skill_files_skill_fqn_idx" })
  skillFqn!: string;

  @Property({ type: "text", fieldName: "rel_path" })
  relPath!: string;

  @Property({ type: "blob" })
  content!: Buffer;
}

// ─── Dependency tables ──────────────────────────────────────

@Entity({ tableName: "agent_skill_dependencies" })
export class AgentSkillDepRow {
  @PrimaryKey({ type: "integer", autoincrement: true })
  rowId!: number;

  @Property({ type: "text", fieldName: "source_fqn" })
  @Index({ name: "agent_skill_deps_src_idx" })
  sourceFqn!: string;

  @Property({ type: "text", fieldName: "target_fqn" })
  @Index({ name: "agent_skill_deps_tgt_idx" })
  targetFqn!: string;
}

@Entity({ tableName: "agent_mcp_dependencies" })
export class AgentMcpDepRow {
  @PrimaryKey({ type: "integer", autoincrement: true })
  rowId!: number;

  @Property({ type: "text", fieldName: "source_fqn" })
  @Index({ name: "agent_mcp_deps_src_idx" })
  sourceFqn!: string;

  @Property({ type: "text", fieldName: "target_fqn" })
  @Index({ name: "agent_mcp_deps_tgt_idx" })
  targetFqn!: string;
}

@Entity({ tableName: "skill_skill_dependencies" })
export class SkillSkillDepRow {
  @PrimaryKey({ type: "integer", autoincrement: true })
  rowId!: number;

  @Property({ type: "text", fieldName: "source_fqn" })
  @Index({ name: "skill_skill_deps_src_idx" })
  sourceFqn!: string;

  @Property({ type: "text", fieldName: "target_fqn" })
  @Index({ name: "skill_skill_deps_tgt_idx" })
  targetFqn!: string;
}

@Entity({ tableName: "skill_mcp_dependencies" })
export class SkillMcpDepRow {
  @PrimaryKey({ type: "integer", autoincrement: true })
  rowId!: number;

  @Property({ type: "text", fieldName: "source_fqn" })
  @Index({ name: "skill_mcp_deps_src_idx" })
  sourceFqn!: string;

  @Property({ type: "text", fieldName: "target_fqn" })
  @Index({ name: "skill_mcp_deps_tgt_idx" })
  targetFqn!: string;
}

export const CATALOG_ENTITIES = [
  AgentRow,
  SkillRow,
  McpRow,
  AgentFileRow,
  SkillFileRow,
  AgentSkillDepRow,
  AgentMcpDepRow,
  SkillSkillDepRow,
  SkillMcpDepRow,
] as const;
