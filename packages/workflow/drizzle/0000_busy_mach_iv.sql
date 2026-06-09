CREATE TABLE `workflow_edges` (
	`workflow_id` text NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	PRIMARY KEY(`workflow_id`, `from_node_id`, `to_node_id`)
);
--> statement-breakpoint
CREATE INDEX `workflow_edges_from_idx` ON `workflow_edges` (`workflow_id`,`from_node_id`);--> statement-breakpoint
CREATE INDEX `workflow_edges_to_idx` ON `workflow_edges` (`workflow_id`,`to_node_id`);--> statement-breakpoint
CREATE TABLE `workflow_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`kind` text NOT NULL,
	`spec_json` text NOT NULL,
	`phase` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`ready_at` text,
	`running_at` text,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `workflow_nodes_workflow_idx` ON `workflow_nodes` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `workflow_nodes_status_idx` ON `workflow_nodes` (`workflow_id`,`status`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`brief` text NOT NULL,
	`cancellation` text,
	`coordinator_agent` text NOT NULL,
	`created_at` text NOT NULL,
	`details` text,
	`ended_at` text,
	`failure` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`started_at` text,
	`status` text NOT NULL,
	`success` text
);
--> statement-breakpoint
CREATE INDEX `workflows_status_idx` ON `workflows` (`status`);--> statement-breakpoint
CREATE INDEX `workflows_coordinator_agent_idx` ON `workflows` (`coordinator_agent`);