import type { SqlEntityManager } from "@mikro-orm/better-sqlite";
import { EntityManager } from "@mikro-orm/core";
import { inject, injectable } from "inversify";
import {
  type AfterCommitCallback,
  currentAfterCommitQueue,
  UnitOfWork,
} from "../application/unit-of-work.js";

/**
 * Workspace bounded-context persistence handle - eShop OrderingContext analog.
 * Owns the EntityManager + the SqlEntityManager cast. Domain-event
 * dispatch is handled by DomainEventDispatcher (MikroORM beforeFlush
 * subscriber registered in bootstrap), so any em.flush automatically
 * publishes pending aggregate events before SQL writes hit SQLite.
 *
 * Extends the generic {@link UnitOfWork} abstraction so the one
 * `TransactionBehavior` shared across BCs can inject the right
 * per-container unit-of-work without coupling to a BC-specific class.
 *
 * The after-commit queue is sourced from the AsyncLocalStorage slot
 * opened by `TransactionBehavior`; outside a transaction (test
 * helpers that drive the EM directly) callbacks run immediately.
 */
@injectable()
export class WorkspaceContext extends UnitOfWork {
  constructor(@inject(EntityManager) private readonly _em: EntityManager) {
    super();
  }

  override get em(): EntityManager {
    return this._em;
  }

  override get sqlEm(): SqlEntityManager {
    return this._em as unknown as SqlEntityManager;
  }

  override enqueueAfterCommit(callback: AfterCommitCallback): void {
    const queue = currentAfterCommitQueue();
    if (queue !== null) {
      queue.push(callback);
      return;
    }
    // No active transaction (typically test helpers driving the EM
    // directly). Run inline so the side-effect still happens; this
    // keeps the production code path consistent — handlers can call
    // enqueueAfterCommit unconditionally.
    void Promise.resolve().then(callback);
  }
}
