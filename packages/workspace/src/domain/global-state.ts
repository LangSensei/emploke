import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

/**
 * Singleton key/value bag scoped to the workspace context's `global.db`.
 *
 * Currently holds exactly one well-known key — `current_workspace_id` —
 * which records the user's last-selected workspace pointer. It lives
 * outside the {@link import("./aggregates/workspace/workspace.js").Workspace}
 * aggregate because it's a cross-row pointer (which workspace is
 * "current"), not a per-workspace invariant.
 *
 * Modeled as a plain MikroORM entity (not an aggregate root) — it has
 * no domain behaviour and no events. Repository / handler code mutates
 * it through the EntityManager (`em.findOne / em.persist / em.upsert /
 * em.remove`) so the unit-of-work + per-context transaction envelope
 * cover it the same way they cover the `Workspace` aggregate.
 *
 * Lives in `domain/` (not `infrastructure/`) for parity with the
 * `Workspace` aggregate: the project has already accepted MikroORM
 * decorators in domain entities, so segregating GlobalState into infra
 * just because it lacks behaviour would be inconsistent.
 *
 * Phase 2 polish (P1-5): replaces the previous raw-SQL access path
 * (`em.execute("SELECT/INSERT/DELETE FROM global_state ...")`). Lets
 * us drop the hand-rolled `CREATE TABLE global_state` statements in
 * `bootstrap.ts` / `testing.ts` and pivot to MikroORM's schema
 * generator + migration discovery for the same shape.
 */
@Entity({ tableName: "global_state" })
export class GlobalState {
  @PrimaryKey({ type: "string" })
  key!: string;

  @Property({ type: "string" })
  value!: string;

  static of(key: string, value: string): GlobalState {
    const row = new GlobalState();
    row.key = key;
    row.value = value;
    return row;
  }
}

/** Well-known keys used in the global_state bag. */
export const GLOBAL_STATE_KEYS = {
  CURRENT_WORKSPACE_ID: "current_workspace_id",
} as const;
