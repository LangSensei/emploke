import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted row for one schedule. Single table + JSON `target_json`
 * column (single-table inheritance) — target field count is small and
 * stable, variants don't cross-reference, v1 has only one variant.
 *
 * **Indexes.** `schedules_target_agent_idx` is a **functional partial
 * index** on `json_extract(target_json, '$.agent')` filtered
 * `WHERE target_kind = 'task'`. Declared via hand-written
 * `drizzle/0001_drop_target_agent_add_json_index.sql` because
 * drizzle-kit cannot express expression indexes in schema; the
 * runtime query in `schedule-repository.ts` MUST use
 * `sql\`json_extract(${schedules.targetJson}, '$.agent')\`` against
 * `target_json` to engage it. The same pattern is used in
 * `@emploke/task` for `tasks_schedule_id_idx`.
 *
 * `next_fire_at` is persisted (despite being derivable from
 * trigger + last_fired_at) so the list endpoint can ORDER BY
 * next_fire_at without N×cron-compute per request. Must be
 * recomputed on `recover()` and on `patch(trigger.*)`.
 *
 * No DB-level FK to `agents` — codebase convention is
 * application-level validation. ScheduleService.create/patch calls
 * the injected `agentValidator(fqn)`.
 */
export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    triggerKind: text("trigger_kind").notNull(),
    triggerExpr: text("trigger_expr").notNull(),
    triggerTz: text("trigger_tz").notNull(),
    targetKind: text("target_kind").notNull(),
    targetJson: text("target_json").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastFiredAt: text("last_fired_at"),
    nextFireAt: text("next_fire_at"),
  },
  (t) => [
    index("schedules_enabled_idx").on(t.enabled),
    index("schedules_next_fire_idx").on(t.nextFireAt),
    // schedules_target_agent_idx is a functional partial index defined
    // in drizzle/0001_*.sql (json_extract on target_json, filtered to
    // target_kind='task'); drizzle-kit can't express it in TS schema.
  ],
);

export type ScheduleRow = typeof schedules.$inferSelect;
export type NewScheduleRow = typeof schedules.$inferInsert;
