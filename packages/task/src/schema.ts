import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted task row. Mirrors the public `Task` rich entity
 * (in `./task-entity.ts`) one-to-one. The repository layer maps
 * row ↔ Task via `rowToTask` / `taskToRowFields`.
 *
 * `runtime` is promoted out of `metadata` into a first-class indexed
 * column so the dashboard's runtime filter reads cleanly.
 *
 * **Indexes.** `tasks_schedule_id_idx` is a **functional partial
 * index** on `json_extract(metadata, '$.scheduleId')` filtered
 * `WHERE origin = 'schedule'`. Declared via hand-written
 * `drizzle/0001_tasks_schedule_id_idx.sql` because drizzle-kit
 * cannot express functional partial indexes in schema; any runtime
 * query that wants to engage it MUST use
 * `sql\`json_extract(${tasks.metadata}, '$.scheduleId')\`` against
 * `metadata` and include the `origin = 'schedule'` filter. The same
 * pattern is used in `@emploke/schedule` for
 * `schedules_target_agent_idx`.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    agent: text("agent").notNull(),
    runtime: text("runtime"),
    status: text("status").notNull(),
    brief: text("brief").notNull(),
    details: text("details"),
    origin: text("origin").notNull(),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    success: text("success"),
    failure: text("failure"),
    cancellation: text("cancellation"),
    metadata: text("metadata").notNull(),
  },
  (t) => [
    index("tasks_agent_idx").on(t.agent),
    index("tasks_runtime_idx").on(t.runtime),
    index("tasks_status_idx").on(t.status),
    index("tasks_origin_idx").on(t.origin),
    // tasks_schedule_id_idx is a functional partial index defined in
    // drizzle/0001_*.sql (json_extract on metadata, filtered to
    // origin='schedule'); drizzle-kit can't express it in TS schema.
  ],
);

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
