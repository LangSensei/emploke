import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted row for one schedule. Single table + JSON `target_json`
 * column (single-table inheritance) — target field count is small and
 * stable, variants don't cross-reference, v1 has only one variant.
 *
 * `target_agent` is a denormalised redundant column for the
 * "list schedules by agent" query path: writer sets it only when
 * `target_kind='task'`, leaves NULL for future kinds. Trade-off
 * accepted in RFC §"Schema rationale" — simpler schema + native
 * b-tree index vs JSON-extract expression index.
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
    targetAgent: text("target_agent"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastFiredAt: text("last_fired_at"),
    nextFireAt: text("next_fire_at"),
  },
  (t) => [
    index("schedules_enabled_idx").on(t.enabled),
    index("schedules_next_fire_idx").on(t.nextFireAt),
    index("schedules_target_agent_idx").on(t.targetAgent),
  ],
);

export type ScheduleRow = typeof schedules.$inferSelect;
export type NewScheduleRow = typeof schedules.$inferInsert;
