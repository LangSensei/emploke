import type { WorkspaceDomainEvent } from "./events/domain-event.js";

/**
 * Base class for every DDD aggregate root in `@emploke/workspace`.
 *
 * Accumulates domain events raised by aggregate transitions into a
 * private buffer; `pullDomainEvents()` drains the buffer and returns
 * the events for downstream dispatch. The buffer is intentionally
 * NOT a MikroORM-decorated property — it lives on the in-memory
 * instance, not the persisted row.
 *
 * ## Dispatch path (post-Phase-2 / ADR-3)
 *
 * The {@link import("../infrastructure/domain-event-subscriber.js").DomainEventSubscriber}
 * walks `args.uow.getChangeSets()` in the MikroORM `afterFlush` hook,
 * detects entities that extend `AggregateRoot`, calls
 * `pullDomainEvents()` on each, and dispatches every event via
 * `mediator.publish(...)`. Handlers no longer publish events
 * themselves — the unit-of-work owns the contract end-to-end.
 *
 * ## Why an abstract class rather than an interface
 *
 * MikroORM's subscriber detects aggregates via `instanceof
 * AggregateRoot` (the only run-time discriminator that survives a
 * transpile cycle). A TypeScript-only `interface` would erase, leaving
 * the subscriber blind. A concrete base class also gives every
 * aggregate the same `addDomainEvent` / `pullDomainEvents` shape
 * without copy-paste.
 *
 * ## Promotion plan (per ADR-3 §scope)
 *
 * Phase 2 lives in `@emploke/workspace` because workspace is the only
 * MikroORM-aware package today. Phase 3+ moves session/task/catalog
 * onto MikroORM; once three or more packages need this base, it
 * promotes to a shared `@emploke/core` package. Until then importing
 * `AggregateRoot` from `@emploke/workspace` is acceptable cross-context
 * usage per naming-conventions §8.3.
 */
export abstract class AggregateRoot {
  private _domainEvents: WorkspaceDomainEvent[] = [];

  /**
   * Record an event raised by a transition. `protected` so external
   * callers cannot inject events into the aggregate — only the
   * aggregate's own methods can.
   */
  protected addDomainEvent(event: WorkspaceDomainEvent): void {
    this._domainEvents.push(event);
  }

  /**
   * Drain the buffered domain events. The MikroORM
   * `DomainEventSubscriber` calls this from `afterFlush` once the
   * change-set has been written to SQLite. Second drains return `[]`.
   *
   * Returned as a `readonly` view so subscribers cannot mutate the
   * aggregate's private buffer state via the returned array.
   */
  pullDomainEvents(): readonly WorkspaceDomainEvent[] {
    const events = this._domainEvents;
    this._domainEvents = [];
    return events;
  }
}
