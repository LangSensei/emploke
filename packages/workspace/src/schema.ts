import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Workspace registry row. Pure Drizzle schema — no class, no
 * decorators, no entity ceremony. Type is derived from this schema
 * via `$inferSelect` / `$inferInsert`.
 */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  workspaceDir: text("workspace_dir").notNull().unique(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  lastOpenedAt: text("last_opened_at"),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
