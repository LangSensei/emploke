import type { SqlEntityManager } from "@mikro-orm/better-sqlite";
import { EntityManager } from "@mikro-orm/core";
import { inject, injectable } from "inversify";
import { Mediator } from "mediatr-ts";
import { AggregateRoot } from "../domain/seedwork/aggregate-root.js";

/**
 * Workspace bounded-context persistence handle - eShop OrderingContext analog.
 * Owns the EntityManager + SqlEntityManager cast + UoW save-pipeline
 * (dispatch domain events then flush, mirroring SaveEntitiesAsync).
 * Phase 3+ contexts copy this shape with their own EM.
 */
@injectable()
export class WorkspaceContext {
  constructor(
    @inject(EntityManager) private readonly _em: EntityManager,
    @inject(Mediator) private readonly _mediator: Mediator,
  ) {}

  get em(): EntityManager {
    return this._em;
  }

  get sqlEm(): SqlEntityManager {
    return this._em as unknown as SqlEntityManager;
  }

  /**
   * UoW commit pipeline. eShop OrderingContext.SaveEntitiesAsync analog.
   * 1) Dispatch buffered domain events through the mediator.
   * 2) Flush change-set to SQLite.
   * Events fire BEFORE writes - aggregate mutations from handlers are
   * included in the upcoming flush. Runs inside the surrounding
   * em.transactional opened by TransactionBehavior, so any throw rolls
   * back both the writes AND the dispatched events.
   */
  async saveEntities(): Promise<void> {
    await this.dispatchDomainEvents();
    await this._em.flush();
  }

  private async dispatchDomainEvents(): Promise<void> {
    const eventsToPublish = [];
    for (const entity of this._em.getUnitOfWork().getIdentityMap()) {
      if (entity instanceof AggregateRoot) {
        eventsToPublish.push(...entity.pullDomainEvents());
      }
    }

    for (const evt of eventsToPublish) {
      try {
        await this._mediator.publish(evt);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("No handler found for notification ")) {
          continue;
        }
        throw err;
      }
    }
  }
}
