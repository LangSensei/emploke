import { Migration } from "@mikro-orm/migrations";

export class Migration00000000000000_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      "create table `mcps` (`fqn` text not null, `origin` text not null, `spec` text not null, `installed_at` text not null, `updated_at` text not null, primary key (`fqn`));",
    );
    this.addSql("create index `mcps_origin` on `mcps` (`origin`);");
    this.addSql("create index `mcps_updated_at` on `mcps` (`updated_at`);");

    this.addSql(
      "create table `skills` (`fqn` text not null, `origin` text not null, `description` text not null, `version` text not null, `prereqs` text null, `prereqs_ack` integer not null default 1, `installed_at` text not null, `updated_at` text not null, primary key (`fqn`));",
    );
    this.addSql("create index `skills_origin` on `skills` (`origin`);");
    this.addSql("create index `skills_updated_at` on `skills` (`updated_at`);");

    this.addSql(
      "create table `agents` (`fqn` text not null, `origin` text not null, `description` text not null, `version` text not null, `prereqs` text null, `prereqs_ack` integer not null default 1, `disabled_by_user` integer not null default 0, `installed_at` text not null, `updated_at` text not null, primary key (`fqn`));",
    );
    this.addSql("create index `agents_origin` on `agents` (`origin`);");
    this.addSql("create index `agents_updated_at` on `agents` (`updated_at`);");

    this.addSql(
      "create table `agent_files` (`row_id` integer not null primary key autoincrement, `agent_fqn` text not null, `rel_path` text not null, `content` blob not null);",
    );
    this.addSql("create index `agent_files_agent_fqn_idx` on `agent_files` (`agent_fqn`);");

    this.addSql(
      "create table `skill_files` (`row_id` integer not null primary key autoincrement, `skill_fqn` text not null, `rel_path` text not null, `content` blob not null);",
    );
    this.addSql("create index `skill_files_skill_fqn_idx` on `skill_files` (`skill_fqn`);");

    this.addSql(
      "create table `agent_skill_dependencies` (`row_id` integer not null primary key autoincrement, `source_fqn` text not null, `target_fqn` text not null);",
    );
    this.addSql("create index `agent_skill_deps_src_idx` on `agent_skill_dependencies` (`source_fqn`);");
    this.addSql("create index `agent_skill_deps_tgt_idx` on `agent_skill_dependencies` (`target_fqn`);");

    this.addSql(
      "create table `agent_mcp_dependencies` (`row_id` integer not null primary key autoincrement, `source_fqn` text not null, `target_fqn` text not null);",
    );
    this.addSql("create index `agent_mcp_deps_src_idx` on `agent_mcp_dependencies` (`source_fqn`);");
    this.addSql("create index `agent_mcp_deps_tgt_idx` on `agent_mcp_dependencies` (`target_fqn`);");

    this.addSql(
      "create table `skill_skill_dependencies` (`row_id` integer not null primary key autoincrement, `source_fqn` text not null, `target_fqn` text not null);",
    );
    this.addSql("create index `skill_skill_deps_src_idx` on `skill_skill_dependencies` (`source_fqn`);");
    this.addSql("create index `skill_skill_deps_tgt_idx` on `skill_skill_dependencies` (`target_fqn`);");

    this.addSql(
      "create table `skill_mcp_dependencies` (`row_id` integer not null primary key autoincrement, `source_fqn` text not null, `target_fqn` text not null);",
    );
    this.addSql("create index `skill_mcp_deps_src_idx` on `skill_mcp_dependencies` (`source_fqn`);");
    this.addSql("create index `skill_mcp_deps_tgt_idx` on `skill_mcp_dependencies` (`target_fqn`);");
  }

  override async down(): Promise<void> {
    this.addSql("drop table if exists `skill_mcp_dependencies`;");
    this.addSql("drop table if exists `skill_skill_dependencies`;");
    this.addSql("drop table if exists `agent_mcp_dependencies`;");
    this.addSql("drop table if exists `agent_skill_dependencies`;");
    this.addSql("drop table if exists `skill_files`;");
    this.addSql("drop table if exists `agent_files`;");
    this.addSql("drop table if exists `agents`;");
    this.addSql("drop table if exists `skills`;");
    this.addSql("drop table if exists `mcps`;");
  }
}
