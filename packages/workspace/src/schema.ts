import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Workspace registry row. Pure Drizzle schema — no class, no
 * decorators, no entity ceremony. Row types are derived via
 * `$inferSelect` / `$inferInsert` and named `WorkspaceRow` /
 * `NewWorkspaceRow` (the internal Drizzle types, never exported
 * beyond the repository) to mirror `SessionRow` / `TaskRow` in
 * sibling pkgs. The public DTO is `Workspace` in `types.ts`.
 */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  workspaceDir: text("workspace_dir").notNull().unique(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  lastOpenedAt: text("last_opened_at"),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
