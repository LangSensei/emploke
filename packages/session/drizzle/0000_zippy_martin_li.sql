CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`runtime` text NOT NULL,
	`created_at` text NOT NULL,
	`runtime_session_id` text,
	`last_launch_mode` text
);
--> statement-breakpoint
CREATE INDEX `sessions_agent_idx` ON `sessions` (`agent`);