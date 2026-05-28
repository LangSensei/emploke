DROP INDEX `schedules_target_agent_idx`;
--> statement-breakpoint
ALTER TABLE `schedules` DROP COLUMN `target_agent`;
--> statement-breakpoint
CREATE INDEX `schedules_target_agent_idx` ON `schedules` (json_extract(`target_json`, '$.agent')) WHERE `target_kind` = 'task';