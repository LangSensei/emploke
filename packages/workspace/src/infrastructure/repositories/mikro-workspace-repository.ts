import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { inject, injectable } from "inversify";
import type { WorkspaceId } from "../../domain/aggregates/workspace/value-objects/workspace-id.js";
import { Workspace } from "../../domain/aggregates/workspace/workspace.js";
import { WorkspaceRepository } from "../../domain/aggregates/workspace/workspace-repository.js";
import {
  WorkspaceIdConflictError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../../domain/exceptions/workspace-errors.js";
import { WorkspaceContext } from "../workspace-context.js";

/** Key in `global_state` holding the current-workspace pointer. */
const CURRENT_WORKSPACE_KEY = "current_workspace_id";

/**
 * MikroORM-backed `WorkspaceRepository`.
 *
 * Phase 2 / ADR-3: the repository no longer owns the SQLite handle —
 * it injects an {@link EntityManager} provided by the MikroORM
 * instance the composition root opens for `global.db`. The previous
 * `SqliteWorkspaceRepository` (raw `node:sqlite` + hand-rolled
 * `BEGIN IMMEDIATE`) is gone; transactions are now provided by the
 * server's `TransactionBehavior` pipeline behaviour (which wraps the
 * whole command pipeline in `em.transactional`).
 *
 * ## `global_state` table
 *
 * The `global_state` key/value table that holds
 * `current_workspace_id` is NOT a MikroORM entity in Phase 2 — it has
 * no aggregate behaviour and is on track to leave workspace pkg
 * entirely (P1-5 in `.ceo/design/polish-backlog.md`). Until then the
 * repository wraps the two raw-SQL accesses behind {@link getCurrent}
 * and {@link setCurrent}. Both go through `em.execute(...)` so they
 * participate in the surrounding transaction.
 *
 * The injected EntityManager is the abstract `@mikro-orm/core`
 * `EntityManager`; we cast to `SqlEntityManager` (from
 * `@mikro-orm/knex`) for the raw-SQL helpers. Workspace pkg only
 * ever runs against a SQL driver, so the cast is sound; the abstract
 * `EntityManager` is the DI token because that's the type
 * `orm.em` exposes at the composition root.
 *
 * ## EntityManager scope
 *
 * The bound `EntityManager` is the orm-root EM (`globalOrm.em`). It
 * is request-scoped by MikroORM's `AsyncLocalStorage`-based
 * `RequestContext` upstream — every concurrent command pipeline sees
 * its own fork courtesy of `em.transactional` in
 * `TransactionBehavior`, so the repository instance can stay a
 * singleton without identity-map cross-talk.
 */
@injectable()
export class MikroWorkspaceRepository extends WorkspaceRepository {
  constructor(@inject(WorkspaceContext) private readonly ctx: WorkspaceContext) {
    super();
  }

  override async add(ws: Workspace): Promise<void> {
    this.ctx.em.persist(ws);
    try {
      // Eager save (via context) surfaces the SQL UNIQUE-constraint
      // violation here so we can translate it into the typed domain
      // error. The outer TransactionBehavior's saveEntities call then
      // sees a clean change-set and becomes a no-op. saveEntities
      // dispatches the WorkspaceRegistered event AND flushes - both
      // BEFORE this method returns so the handler observes a fully
      // committed (within the surrounding transaction) write.
      await this.ctx.saveEntities();
    } catch (err) {
      // Translate the SQL-level UNIQUE violation into the typed
      // domain error the wire layer maps to HTTP 409. MikroORM v6
      // surfaces the constraint name in `err.message`; we sniff for
      // the column name we own (`workspace_dir`) to distinguish
      // path-conflict from id-conflict. PRIMARY KEY (`id`) violations
      // don't reliably carry the column name across SQLite drivers,
      // so the fallback is `WorkspaceIdConflictError`. The existing
      // id is the only id we have in hand — Phase 2's UNIQUE-driven
      // check does not return the colliding row, hence the
      // `<unknown>` sentinel on `WorkspacePathConflictError.existingId`.
      if (err instanceof UniqueConstraintViolationException) {
        // SQLite UNIQUE violations report a qualified column name in
        // the form `<table>.<column>` (e.g. `workspaces.workspace_dir`
        // or `workspaces.id`). MikroORM wraps the original SQL
        // statement into the exception message too, and that INSERT
        // statement lists every column - including `workspace_dir` -
        // so a loose `includes("workspace_dir")` match would also
        // catch PK collisions and mis-route them as path conflicts.
        // Match the dot-qualified constraint name instead, which only
        // appears in the violation suffix.
        const msg = err.message.toLowerCase();
        if (msg.includes("workspaces.workspace_dir")) {
          throw new WorkspacePathConflictError(ws.workspaceDir, "<unknown>");
        }
        throw new WorkspaceIdConflictError(ws.id);
      }
      throw err;
    }
  }

  override async findById(id: WorkspaceId): Promise<Workspace | null> {
    return this.ctx.em.findOne(Workspace, { id: id.value });
  }

  override async delete(id: WorkspaceId): Promise<void> {
    const ws = await this.ctx.em.findOne(Workspace, { id: id.value });
    if (!ws) return; // idempotent — deleting a missing row is a no-op
    this.ctx.em.remove(ws);
    // Also clear the current-workspace pointer if it was this id.
    // Same em.transactional batch as the remove, so the DELETE on
    // global_state is atomic with the DELETE on workspaces.
    await this.ctx.sqlEm.execute("DELETE FROM global_state WHERE key = ? AND value = ?", [
      CURRENT_WORKSPACE_KEY,
      id.value,
    ]);
  }

  override async getCurrent(): Promise<string | null> {
    const rows = (await this.ctx.sqlEm.execute("SELECT value FROM global_state WHERE key = ?", [
      CURRENT_WORKSPACE_KEY,
    ])) as Array<{ value: string }>;
    return rows[0]?.value ?? null;
  }

  override async setCurrent(id: WorkspaceId): Promise<void> {
    const exists = await this.ctx.em.findOne(Workspace, { id: id.value });
    if (!exists) {
      throw new WorkspaceNotRegisteredError(id.value);
    }
    // ON CONFLICT upsert against the `global_state` key/value bag.
    // SQLite's `INSERT … ON CONFLICT … DO UPDATE` is the canonical
    // idiom; works under both better-sqlite3 and node:sqlite drivers.
    //
    // Phase 2 dropped the legacy `last_opened_at` audit column — the
    // pre-ADR repo bumped it here so the dashboard could sort
    // workspaces by recency. The dashboard's recency column wasn't
    // shipped (it was speculative wire surface) and the column
    // wasn't an aggregate invariant, so wiping it lets the entity
    // stay minimal. If recency UX ever lands, Phase 3+ adds it back
    // as a proper `@Property` and the bump moves into the
    // `Workspace` aggregate.
    await this.ctx.sqlEm.execute(
      `INSERT INTO global_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [CURRENT_WORKSPACE_KEY, id.value],
    );
  }
}
