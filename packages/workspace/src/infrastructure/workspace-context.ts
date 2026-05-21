import type { SqlEntityManager } from "@mikro-orm/better-sqlite";
import { EntityManager } from "@mikro-orm/core";
import { inject, injectable } from "inversify";

/**
 * Workspace bounded-context persistence handle - eShop OrderingContext analog.
 * Owns the EntityManager + the SqlEntityManager cast. Domain-event
 * dispatch is handled by DomainEventDispatcher (MikroORM beforeFlush
 * subscriber registered in bootstrap), so any em.flush automatically
 * publishes pending aggregate events before SQL writes hit SQLite.
 *
 * Design A (per-BC ORM, per-BC Mediator): each bounded context owns
 * its own MikroORM + EntityManager + Mediator. There's NO shared
 * abstract UnitOfWork — every BC has its own concrete context class
 * and its own TransactionBehavior that injects that class directly.
 * The {@link enqueueAfterCommit} helper from `./after-commit-queue.ts`
 * IS cross-BC (just a module-level AsyncLocalStorage-scoped queue),
 * which is fine because the queue logic is generic.
 */
@injectable()
export class WorkspaceContext {
  constructor(@inject(EntityManager) private readonly _em: EntityManager) {}

  get em(): EntityManager {
    return this._em;
  }

  get sqlEm(): SqlEntityManager {
    return this._em as unknown as SqlEntityManager;
  }
}
