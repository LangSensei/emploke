import type { EventSubscriber, FlushEventArgs } from "@mikro-orm/core";
import { inject, injectable } from "inversify";
import { Mediator } from "mediatr-ts";
import { AggregateRoot } from "../domain/seedwork/aggregate-root.js";

/**
 * MikroORM `EventSubscriber` that drains buffered domain events from
 * every tracked aggregate in the unit-of-work and publishes them
 * through the mediator. Wired into the workspace pkg's MikroORM
 * instance by the composition root (`bootstrap.ts`).
 *
 * ## Trigger point: `beforeFlush`
 *
 * MikroORM fires this hook AFTER the change-set has been computed
 * but BEFORE any SQL INSERT/UPDATE/DELETE is issued. Dispatching
 * here matches eShop `OrderingContext.SaveEntitiesAsync` semantics:
 * domain events fire while the surrounding `em.transactional` scope
 * is still open, so any throw from a notification handler rolls back
 * the entire transaction (writes + the dispatched events are atomic
 * from the caller's POV - the failed write never becomes visible).
 *
 * ## "No handler found" swallow
 *
 * mediatr-ts throws `Error("No handler found for notification ...")`
 * when an event has zero subscribers. Phase 2 workspace events have
 * no upstream subscribers (workspace is the root context); the swallow
 * keeps the dispatch path green. Phase 3+ wires real subscribers, at
 * which point mediatr-ts stops throwing for those event types.
 *
 * ## Why `instanceof AggregateRoot`
 *
 * The UoW change-set can contain entities from any context that ever
 * gets layered onto the same EM (Phase 3+ may add per-workspace
 * entities). The base-class check is the only run-time discriminator
 * that survives a transpile cycle - a TypeScript `interface` would
 * erase, leaving the subscriber blind.
 */
@injectable()
export class DomainEventDispatcher implements EventSubscriber {
  constructor(@inject(Mediator) private readonly mediator: Mediator) {}

  async beforeFlush(args: FlushEventArgs): Promise<void> {
    for (const entity of args.uow.getIdentityMap()) {
      if (entity instanceof AggregateRoot) {
        for (const evt of entity.pullDomainEvents()) {
          try {
            await this.mediator.publish(evt);
          } catch (err) {
            if (
              err instanceof Error &&
              err.message.startsWith("No handler found for notification ")
            ) {
              continue;
            }
            throw err;
          }
        }
      }
    }
  }
}
