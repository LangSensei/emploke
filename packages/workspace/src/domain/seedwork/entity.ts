import type { NotificationData } from "mediatr-ts";

/**
 * Base class for every domain entity in `@emploke/workspace`.
 *
 * Mirrors eShop's `Entity` (Ordering.Domain/SeedWork/Entity.cs):
 * identity (`id`) + identity-based equality + a buffer of domain
 * events the aggregate has raised but not yet dispatched.
 *
 * ## Identity vs. value
 *
 * An entity has **identity** (`id`); equality is by id + concrete
 * type, NOT by value (cf. {@link ValueObject}, which compares
 * structurally). Entities CAN be persisted as their own table; what
 * they CANNOT do is be retrieved via their own repository  only
 * aggregate roots (entities that also implement {@link AggregateRoot})
 * may have a repository in the consistency-boundary sense.
 *
 * `id` is declared as a plain (non-readonly) abstract property so
 * concrete subclasses can still assign it under MikroORM's hydration
 * path (`ws.id = ...`). eShop's `IsTransient()` helper has no analog
 * here: workspace ids are UUIDs assigned at construction, never
 * DB-generated, so an entity instance always has a stable id.
 *
 * ## Domain events buffer
 *
 * Aggregates accumulate events via `addDomainEvent`; the
 * `DomainEventDispatcher` MikroORM subscriber drains them via
 * `pullDomainEvents` on `beforeFlush` and publishes through the
 * mediator. The buffer is non-decorated (no `@Property`) so MikroORM
 * never tries to persist it.
 *
 * Events are typed as mediatr-ts's {@link NotificationData}
 * the dispatch contract  rather than a per-pkg marker base.
 * Concrete event classes `extend NotificationData` directly and
 * declare whatever fields their handlers need (e.g. `occurredAt`).
 * Mirrors eShop's `IDomainEvent : INotification` empty-marker
 * approach without even the empty marker, since we have no code
 * that switches on a per-pkg type.
 *
 * **No silent swallow on missing handlers.** If an aggregate raises
 * an event whose class has no registered notification handler, the
 * mediator throws and the surrounding transaction rolls back. This
 * enforces the rule "no event class exists without a handler" at
 * runtime  a forgotten handler is a loud, immediate failure rather
 * than dead-code rot.
 */
export abstract class Entity {
  abstract id: string;

  private _domainEvents: NotificationData[] = [];

  /**
   * Append an event to the buffer. Called from inside aggregate
   * transition methods (e.g. `Workspace.open`) right after the
   * state mutation succeeds.
   */
  protected addDomainEvent(event: NotificationData): void {
    this._domainEvents.push(event);
  }

  /** Drop a single buffered event. Mirror of eShop's `RemoveDomainEvent`. */
  protected removeDomainEvent(event: NotificationData): void {
    const idx = this._domainEvents.indexOf(event);
    if (idx >= 0) this._domainEvents.splice(idx, 1);
  }

  /** Empty the buffer without dispatching. Mirror of eShop's `ClearDomainEvents`. */
  clearDomainEvents(): void {
    this._domainEvents = [];
  }

  /**
   * Take ownership of every buffered event and clear the buffer.
   * Called by `DomainEventDispatcher` at flush time so re-flushes of
   * the same aggregate don't re-publish the same events.
   */
  pullDomainEvents(): NotificationData[] {
    const out = this._domainEvents;
    this._domainEvents = [];
    return out;
  }

  /**
   * Identity equality: same concrete type and same id. Mirrors eShop's
   * `Entity.Equals` minus the transient-id branch (we don't have
   * transient entities  see class jsdoc).
   */
  equals(other: unknown): boolean {
    if (this === other) return true;
    if (!(other instanceof Entity)) return false;
    if (this.constructor !== other.constructor) return false;
    return this.id === other.id;
  }
}
