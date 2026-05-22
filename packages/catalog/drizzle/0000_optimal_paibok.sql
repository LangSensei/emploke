CREATE TABLE `agent_files` (
	`row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_fqn` text NOT NULL,
	`rel_path` text NOT NULL,
	`content` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_files_agent_fqn_idx` ON `agent_files` (`agent_fqn`);--> statement-breakpoint
CREATE TABLE `agent_mcp_dependencies` (
	`row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_fqn` text NOT NULL,
	`target_fqn` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_mcp_deps_src_idx` ON `agent_mcp_dependencies` (`source_fqn`);--> statement-breakpoint
CREATE INDEX `agent_mcp_deps_tgt_idx` ON `agent_mcp_dependencies` (`target_fqn`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_mcp_deps_uniq` ON `agent_mcp_dependencies` (`source_fqn`,`target_fqn`);--> statement-breakpoint
CREATE TABLE `agent_skill_dependencies` (
	`row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_fqn` text NOT NULL,
	`target_fqn` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_skill_deps_src_idx` ON `agent_skill_dependencies` (`source_fqn`);--> statement-breakpoint
CREATE INDEX `agent_skill_deps_tgt_idx` ON `agent_skill_dependencies` (`target_fqn`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_skill_deps_uniq` ON `agent_skill_dependencies` (`source_fqn`,`target_fqn`);--> statement-breakpoint
CREATE TABLE `agents` (
	`fqn` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`description` text NOT NULL,
	`version` text NOT NULL,
	`prereqs` text,
	`prereqs_ack` integer DEFAULT 1 NOT NULL,
	`disabled_by_user` integer DEFAULT 0 NOT NULL,
	`installed_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_origin` ON `agents` (`origin`);--> statement-breakpoint
CREATE INDEX `agents_updated_at` ON `agents` (`updated_at`);--> statement-breakpoint
CREATE TABLE `mcps` (
	`fqn` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`spec` text NOT NULL,
	`installed_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mcps_origin` ON `mcps` (`origin`);--> statement-breakpoint
CREATE INDEX `mcps_updated_at` ON `mcps` (`updated_at`);--> statement-breakpoint
CREATE TABLE `skill_files` (
	`row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`skill_fqn` text NOT NULL,
	`rel_path` text NOT NULL,
	`content` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `skill_files_skill_fqn_idx` ON `skill_files` (`skill_fqn`);--> statement-breakpoint
CREATE TABLE `skill_mcp_dependencies` (
	`row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_fqn` text NOT NULL,
	`target_fqn` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `skill_mcp_deps_src_idx` ON `skill_mcp_dependencies` (`source_fqn`);--> statement-breakpoint
CREATE INDEX `skill_mcp_deps_tgt_idx` ON `skill_mcp_dependencies` (`target_fqn`);--> statement-breakpoint
CREATE UNIQUE INDEX `skill_mcp_deps_uniq` ON `skill_mcp_dependencies` (`source_fqn`,`target_fqn`);--> statement-breakpoint
CREATE TABLE `skill_skill_dependencies` (
	`row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_fqn` text NOT NULL,
	`target_fqn` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `skill_skill_deps_src_idx` ON `skill_skill_dependencies` (`source_fqn`);--> statement-breakpoint
CREATE INDEX `skill_skill_deps_tgt_idx` ON `skill_skill_dependencies` (`target_fqn`);--> statement-breakpoint
CREATE UNIQUE INDEX `skill_skill_deps_uniq` ON `skill_skill_dependencies` (`source_fqn`,`target_fqn`);--> statement-breakpoint
CREATE TABLE `skills` (
	`fqn` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`description` text NOT NULL,
	`version` text NOT NULL,
	`prereqs` text,
	`prereqs_ack` integer DEFAULT 1 NOT NULL,
	`installed_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `skills_origin` ON `skills` (`origin`);--> statement-breakpoint
CREATE INDEX `skills_updated_at` ON `skills` (`updated_at`);