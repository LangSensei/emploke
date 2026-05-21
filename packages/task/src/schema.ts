import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

/**
 * Persisted task row. Mirrors the public `Task` rich entity
 * (in `./task-entity.ts`) one-to-one. The repository layer maps
 * row ↔ Task via `rowToTask` / `taskToRowFields`.
 *
 * `runtime` is promoted out of `metadata` into a first-class indexed
 * column so the dashboard's runtime filter reads cleanly.
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
  ],
);

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
