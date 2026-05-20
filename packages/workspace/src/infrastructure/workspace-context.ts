import type { SqlEntityManager } from "@mikro-orm/better-sqlite";
import { EntityManager } from "@mikro-orm/core";
import { inject, injectable } from "inversify";

/**
 * Workspace bounded-context persistence handle (eShop's `OrderingContext` analog).
 *
 * Centralises the {@link EntityManager} cast to {@link SqlEntityManager}
 * that every workspace persistence adapter (repository, queries,
 * transaction behaviour) used to redo by hand, and gives the
 * composition root a single typed seam to bind per workspace bounded
 * context. ADR-4 (#141) extends this pattern: each Phase 3+ context
 * (session / task / catalog) declares its own `<Name>Context` class
 * around its own EM instance.
 *
 * The cast from {@link EntityManager} to {@link SqlEntityManager} is
 * sound because the workspace pkg only ever runs against a SQL driver
 * (`@mikro-orm/better-sqlite`). The base {@link EntityManager} is what
 * `orm.em` exposes at the composition root and is the DI binding
 * target; the SQL-specific surface gives access to raw SQL
 * (`execute(...)`) and QueryBuilder (`createQueryBuilder(...)`) that
 * the read side and the auxiliary `global_state` key/value table need.
 *
 * ## Why a class, not just a re-export of `EntityManager`
 *
 * Phase 2 callers care about *workspace-context-owned* persistence,
 * not "MikroORM EM in general". Naming this class for the bounded
 * context (a) makes the DDD intent explicit at every injection site
 * and (b) gives us a stable extension point for future
 * UnitOfWork-style helpers (e.g. a `SaveEntitiesAsync` analog) without
 * having to subclass MikroORM internals.
 */
@injectable()
export class WorkspaceContext {
  constructor(@inject(EntityManager) private readonly _em: EntityManager) {}

  /** The MikroORM-core EntityManager. UoW: persist / remove / flush / transactional. */
  get em(): EntityManager {
    return this._em;
  }

  /**
   * SQL-driver surface (`@mikro-orm/better-sqlite`). Use this for
   * `execute(...)` raw SQL and `createQueryBuilder(...)` read-side
   * projections. Mutations should still go through {@link em} so the
   * change-set + domain events run through the
   * `DomainEventSubscriber.afterFlush` hook.
   */
  get sqlEm(): SqlEntityManager {
    return this._em as unknown as SqlEntityManager;
  }
}
