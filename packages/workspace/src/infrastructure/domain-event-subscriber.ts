import type { EventSubscriber, FlushEventArgs } from "@mikro-orm/core";
import { inject, injectable } from "inversify";
import { Mediator } from "mediatr-ts";
import { AggregateRoot } from "../domain/seedwork/aggregate-root.js";

/**
 * MikroORM `EventSubscriber` that dispatches accumulated aggregate
 * domain events through `mediator.publish(...)` after each flush.
 *
 * ## Order of operations (per ADR-3)
 *
 * `TransactionBehavior` wraps the whole command pipeline in
 * `em.transactional`. MikroORM's flush triggers in roughly this
 * order:
 *
 *   1. command handler mutates entities (no save calls needed —
 *      tracked entities are picked up by the unit-of-work)
 *   2. `em.flush()` writes every INSERT/UPDATE/DELETE inside the
 *      surrounding transaction
 *   3. `afterFlush` fires — this subscriber runs, walking the
 *      change-set and publishing events
 *   4. if any subscriber throws (or the publish handler throws),
 *      `em.transactional` rolls back; the SQL writes are reverted
 *      together with the unpublished events
 *   5. on success, `em.transactional` commits and the pipeline
 *      returns the command handler's result
 *
 * The "publish before commit" timing intentionally matches the
 * eShop-Reference "transactional outbox light" pattern — handler
 * failures (a notification subscriber throws) abort the entire write,
 * so callers never observe a half-published commit. Cross-context
 * **integration** events (Phase 7+) move to an outbox table and
 * survive a process crash; in-process domain events are happy with
 * the synchronous publish path.
 *
 * ## Why `instanceof AggregateRoot`
 *
 * MikroORM's change-set carries every tracked entity, including ones
 * the workspace pkg doesn't own (future per-workspace catalog /
 * session / task entities). The base-class check is the only
 * run-time discriminator that survives transpilation; a TypeScript
 * `interface` would erase.
 *
 * ## Idempotency
 *
 * `pullDomainEvents()` drains the buffer on read — a second flush
 * over the same entity sees an empty list. Equivalent change-sets
 * for entities that didn't accumulate new events publish nothing.
 */
@injectable()
export class DomainEventSubscriber implements EventSubscriber {
  constructor(@inject(Mediator) private readonly mediator: Mediator) {}

  async afterFlush(args: FlushEventArgs): Promise<void> {
    for (const cs of args.uow.getChangeSets()) {
      const entity = cs.entity;
      if (entity instanceof AggregateRoot) {
        for (const evt of entity.pullDomainEvents()) {
          try {
            await this.mediator.publish(evt);
          } catch (err) {
            // mediatr-ts surfaces "no handler registered" as a thrown
            // Error with a stable prefix. Phase 2 has zero
            // notification handlers (workspace is the root context
            // with no upstream subscribers), so the publish call
            // throws once per event. Treat the no-handler case as
            // success — when a future phase wires a real subscriber
            // in, mediatr-ts stops throwing and the dispatch happens
            // automatically.
            //
            // BREADCRUMB for future mediatr-ts upgrades: the swallow
            // matches on the exact prefix "No handler found for
            // notification ". mediatr-ts does NOT export a typed
            // `NoHandlerError`, so message matching is the only
            // practical guard. When bumping mediatr-ts, re-verify
            // this prefix; a silent mismatch would surface as a
            // dispatch failure on the next CI run.
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
