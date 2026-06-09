-- Final shape cleanup for the workflow substrate.
--
-- 1. Drops the (workflow_id, phase) composite index. The substrate's
--    read paths order by phase only inside the per-workflow result
--    set surfaced by `workflow_nodes_workflow_idx`; SQLite's planner
--    sorts that small set in memory rather than walking a second
--    index, so the phase index never appeared in any EXPLAIN QUERY
--    PLAN that mattered. Dropping it removes a per-row write cost
--    and trims the on-disk footprint.
--
-- 2. Coerces legacy terminal-payload discriminator values onto the
--    current single-arm vocabulary so the read path's tolerance
--    branch becomes unreachable for any row written prior to the
--    enum tightening:
--      * `failure.kind` in {`coord`, `internal`} -> `coordinator`
--      * `cancellation.kind` = `cascade` -> `user`
--    Mirrors the in-process coercion in `parseTerminalPayload` so
--    inserts written today and rows touched by this migration agree
--    on the discriminator vocabulary.
--
-- 3. Backfills `started_at` for any pre-existing workflow row that
--    was created before the engine started populating the column at
--    insert time. `started_at` is now mandatory at write time (the
--    repository asserts it); the backfill makes the column non-null
--    for the entire historical fleet so a future `NOT NULL` tighten
--    is a no-op at migration time.
DROP INDEX IF EXISTS `workflow_nodes_phase_idx`;
--> statement-breakpoint
UPDATE `workflows` SET `failure` = json_set(`failure`, '$.kind', 'coordinator') WHERE json_extract(`failure`, '$.kind') IN ('coord', 'internal');
--> statement-breakpoint
UPDATE `workflows` SET `cancellation` = json_set(`cancellation`, '$.kind', 'user') WHERE json_extract(`cancellation`, '$.kind') = 'cascade';
--> statement-breakpoint
UPDATE `workflows` SET `started_at` = `created_at` WHERE `started_at` IS NULL;