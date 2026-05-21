CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_dir` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`last_opened_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_workspace_dir_unique` ON `workspaces` (`workspace_dir`);