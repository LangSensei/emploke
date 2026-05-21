import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

/**
 * Persistent workspace row.
 *
 * Plain MikroORM entity — primitives only, no value objects, no
 * inheritance from a domain seedwork base. Service code reads / writes
 * fields directly. Validation lives in `./validators.ts`; the service
 * (`WorkspaceService`) runs validators at the API boundary before
 * mutating the entity.
 *
 * Naming:
 *   - `workspaceDir` (column `workspace_dir`) is the workspace's root
 *     directory.
 *   - `lastOpenedAt` is set on register (registration is implicit
 *     first-open) and updated by `WorkspaceService.open`. The row with
 *     the greatest `lastOpenedAt` is what `WorkspaceQueries.getLastOpened`
 *     surfaces as the "current" workspace.
 *
 * MikroORM hydration bypasses any constructor we declare, so the
 * fields are non-null assertions for the ORM-loaded path; the service
 * assembles fresh rows by `new Workspace()` + field assignment.
 */
@Entity({ tableName: "workspaces" })
export class Workspace {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ name: "workspace_dir", unique: true })
  workspaceDir!: string;

  @Property()
  name!: string;

  @Property({ name: "created_at" })
  createdAt!: string;

  @Property({ name: "last_opened_at", nullable: true, type: "string" })
  lastOpenedAt: string | null = null;
}

/** Entity list passed to `MikroORM.init({ entities, ... })`. */
export const WORKSPACE_ENTITIES = [Workspace] as const;
