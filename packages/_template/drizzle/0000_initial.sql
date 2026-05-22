CREATE TABLE `__entities__` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `__entities___name_idx` ON `__entities__` (`name`);
