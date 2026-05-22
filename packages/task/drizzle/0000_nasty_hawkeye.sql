CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`runtime` text,
	`status` text NOT NULL,
	`brief` text NOT NULL,
	`details` text,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`success` text,
	`failure` text,
	`cancellation` text,
	`metadata` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_agent_idx` ON `tasks` (`agent`);--> statement-breakpoint
CREATE INDEX `tasks_runtime_idx` ON `tasks` (`runtime`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_origin_idx` ON `tasks` (`origin`);