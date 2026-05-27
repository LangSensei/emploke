CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`trigger_kind` text NOT NULL,
	`trigger_expr` text NOT NULL,
	`trigger_tz` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_json` text NOT NULL,
	`target_agent` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_fired_at` text,
	`next_fire_at` text
);
--> statement-breakpoint
CREATE INDEX `schedules_enabled_idx` ON `schedules` (`enabled`);--> statement-breakpoint
CREATE INDEX `schedules_next_fire_idx` ON `schedules` (`next_fire_at`);--> statement-breakpoint
CREATE INDEX `schedules_target_agent_idx` ON `schedules` (`target_agent`);