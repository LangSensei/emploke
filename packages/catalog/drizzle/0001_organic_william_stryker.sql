CREATE TABLE `agent_agent_dependencies` (
	`row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_fqn` text NOT NULL,
	`target_fqn` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_agent_deps_src_idx` ON `agent_agent_dependencies` (`source_fqn`);--> statement-breakpoint
CREATE INDEX `agent_agent_deps_tgt_idx` ON `agent_agent_dependencies` (`target_fqn`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_agent_deps_uniq` ON `agent_agent_dependencies` (`source_fqn`,`target_fqn`);