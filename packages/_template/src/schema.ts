import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted row for one `__Entity__`. Define exactly the columns this
 * BC owns; cross-BC relations are NOT modelled with foreign keys —
 * dependents look up by id through their own queries layer.
 */
export const __entities__ = sqliteTable(
  "__entities__",
  {
    id: text("id").primaryKey(),
    // TODO: replace with the actual columns for this entity.
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("__entities___name_idx").on(t.name)],
);

export type __Entity__Row = typeof __entities__.$inferSelect;
export type New__Entity__Row = typeof __entities__.$inferInsert;
