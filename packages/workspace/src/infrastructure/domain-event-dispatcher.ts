import type { EventSubscriber, FlushEventArgs } from "@mikro-orm/core";
import { inject, injectable } from "inversify";
import { Mediator } from "mediatr-ts";
import { Entity } from "../domain/seedwork/entity.js";

/**
 * MikroORM `EventSubscriber` that drains buffered domain events from
 * every tracked entity in the unit-of-work and publishes them
 * through the mediator. Wired into the workspace pkg's MikroORM
 * instance by `composeWorkspaceModule`.
 *
 * ## Trigger point: `beforeFlush`
 *
 * MikroORM fires this hook AFTER the change-set has been computed
 * but BEFORE any SQL INSERT/UPDATE/DELETE is issued. Dispatching
 * here matches eShop `OrderingContext.SaveEntitiesAsync` semantics:
 * domain events fire while the surrounding `em.transactional` scope
 * is still open, so any throw from a notification handler rolls back
 * the entire transaction (writes + the dispatched events are atomic
 * from the caller's POV  the failed write never becomes visible).
 *
 * ## No "missing handler" swallow
 *
 * `mediator.publish` errors propagate untouched  including
 * mediatr-ts's `Error("No handler found for notification ...")`.
 * That surface is intentional: an aggregate raising an event with
 * no registered handler is a programming error (dead event class,
 * forgotten handler registration) and should fail the flush loudly,
 * not be silently dropped. The "no event class exists without a
 * handler" rule is enforced by this exact behaviour.
 *
 * ## Why `instanceof Entity`
 *
 * The events buffer lives on the seedwork {@link Entity} base, which
 * BOTH aggregate roots and inner entities extend. Filtering on the
 * domain `Entity` (not MikroORM's `BaseEntity`) ensures we only pull
 * from objects that actually have a `pullDomainEvents` buffer.
 */
@injectable()
export class DomainEventDispatcher implements EventSubscriber {
  constructor(@inject(Mediator) private readonly mediator: Mediator) {}

  async beforeFlush(args: FlushEventArgs): Promise<void> {
    for (const entity of args.uow.getIdentityMap()) {
      if (entity instanceof Entity) {
        for (const evt of entity.pullDomainEvents()) {
          await this.mediator.publish(evt);
        }
      }
    }
  }
}
