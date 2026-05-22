import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Workspace registry row. Pure Drizzle schema — no class, no
 * decorators, no entity ceremony. Row types are derived via
 * `$inferSelect` / `$inferInsert` and named `WorkspaceRow` /
 * `NewWorkspaceRow` to mirror `SessionRow` / `TaskRow` in sibling
 * pkgs (per `docs/pkg-template.md` Section 11: `<Entity>Row` is the
 * internal Drizzle type, never exported beyond the repository; the
 * public DTO is `Workspace` in `types.ts`).
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
