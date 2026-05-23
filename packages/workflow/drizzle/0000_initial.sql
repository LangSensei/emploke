CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`brief` text NOT NULL,
	`details` text,
	`status` text NOT NULL,
	`outcome` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`archived_at` text
);
--> statement-breakpoint
CREATE TABLE `workflow_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`type` text DEFAULT 'task' NOT NULL,
	`status` text NOT NULL,
	`spec` text DEFAULT '{}' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`ready_at` text,
	`running_at` text,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `workflow_nodes_workflow_idx` ON `workflow_nodes` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `workflow_nodes_status_idx` ON `workflow_nodes` (`workflow_id`,`status`);--> statement-breakpoint
CREATE TABLE `workflow_edges` (
	`workflow_id` text NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	PRIMARY KEY(`workflow_id`, `from_node_id`, `to_node_id`)
);
--> statement-breakpoint
CREATE INDEX `workflow_edges_from_idx` ON `workflow_edges` (`workflow_id`,`from_node_id`);--> statement-breakpoint
CREATE INDEX `workflow_edges_to_idx` ON `workflow_edges` (`workflow_id`,`to_node_id`);
