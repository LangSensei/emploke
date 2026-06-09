-- Adds typed terminal payload columns to workflows. Mirrors
-- @emploke/task's success / failure / cancellation discriminated
-- payload shape (each terminal status carries its own typed JSON
-- blob; running rows have all three null).
--
-- No backfill needed: any row predating these columns is already
-- terminal with no payload attached. They surface in the dashboard
-- via the read-path tolerance branch ("the row is terminal but
-- carries no payload — render a placeholder").
--
-- Columns added in alphabetical order to match the schema.ts
-- declaration order so the drizzle drift guard (which compares
-- introspected column ordering against the schema) keeps passing.
ALTER TABLE `workflows` ADD COLUMN `cancellation` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD COLUMN `failure` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD COLUMN `success` text;
