import type { SqlEntityManager } from "@mikro-orm/better-sqlite";
import { EntityManager } from "@mikro-orm/core";
import { inject, injectable } from "inversify";

/**
 * Workspace bounded-context persistence handle - eShop OrderingContext analog.
 * Owns the EntityManager + the SqlEntityManager cast. Domain-event
 * dispatch is handled by DomainEventDispatcher (MikroORM beforeFlush
 * subscriber registered in bootstrap), so any em.flush automatically
 * publishes pending aggregate events before SQL writes hit SQLite.
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
