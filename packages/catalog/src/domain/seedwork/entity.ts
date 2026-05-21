/** Marker type for catalog domain events. Was mediatr-ts DomainEvent;
 * since the catalog event bus was never wired (PR-1 only), this is a
 * local placeholder so the buffer code still compiles. */
export type DomainEvent = object;

/**
 * Base class for every domain entity in `@emploke/catalog`.
 *
 * Mirrors `@emploke/workspace`'s seedwork `Entity` (which itself
 * mirrors eShop's `Ordering.Domain/SeedWork/Entity.cs`): identity
 * (`id`) + identity-based equality + a buffer of domain events the
 * aggregate has raised but not yet dispatched.
 *
 * ## Why each BC owns its own seedwork
 *
 * Cross-context import rules (ADR-5/8): the **marker types and
 * primitives** of one BC's seedwork must not leak across BCs. If
 * catalog imported `Entity` from `@emploke/workspace`, a coupling
 * point would exist that the architecture explicitly forbids.
 * Each BC keeps its own copy until enough copies exist to justify
 * lifting into a shared seedwork package — at which point the lift
 * is a deliberate decision, not an accident.
 *
 * ## Identity vs. value
 *
 * An entity has **identity** (`id`); equality is by id + concrete
 * type, NOT by value (cf. {@link ValueObject}, which compares
 * structurally). For catalog aggregates `id` is the FQN — `fqn` is
 * the natural key already used as the SQLite primary key. There is
 * no synthetic UUID; renames are modelled as delete + reinstall.
 *
 * ## Domain events buffer
 *
 * Aggregates accumulate events via `addDomainEvent`; an ORM
 * subscriber (analogous to workspace's `DomainEventDispatcher`) will
 * drain them via `pullDomainEvents` at flush time and publish
 * through the mediator. Events are typed as mediatr-ts's
 * {@link DomainEvent} — the dispatch contract — rather than a
 * per-pkg marker base, mirroring eShop's `IDomainEvent : INotification`
 * empty-marker approach.
 *
 * **No silent swallow on missing handlers.** If an aggregate raises
 * an event whose class has no registered notification handler, the
 * mediator throws and the surrounding transaction rolls back. This
 * enforces the rule "no event class exists without a handler" at
 * runtime.
 *
 * ## Note on copy-returning transitions
 *
 * Catalog aggregates currently expose copy-returning transition
 * methods (`Mcp.withContent(...)`, `Skill.withState(...)` etc.) that
 * pre-date this seedwork. Until those methods are redesigned to
 * mutate-in-place (or to forward the event buffer), aggregates must
 * NOT raise domain events: a returned copy starts with a fresh
 * empty buffer and would lose any events the previous instance had
 * pending. The base class supports events; consumers must opt in
 * deliberately as part of a focused redesign of the aggregate's
 * transition style. PR-1 wires the buffer; PR-2+ uses it.
 */
export abstract class Entity {
  abstract id: string;

  private _domainEvents: DomainEvent[] = [];

  /**
   * Append an event to the buffer. Called from inside aggregate
   * transition methods right after the state mutation succeeds.
   */
  protected addDomainEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }

  /** Drop a single buffered event. Mirror of eShop's `RemoveDomainEvent`. */
  protected removeDomainEvent(event: DomainEvent): void {
    const idx = this._domainEvents.indexOf(event);
    if (idx >= 0) this._domainEvents.splice(idx, 1);
  }

  /** Empty the buffer without dispatching. Mirror of eShop's `ClearDomainEvents`. */
  clearDomainEvents(): void {
    this._domainEvents = [];
  }

  /**
   * Take ownership of every buffered event and clear the buffer.
   * Called by an ORM dispatcher subscriber at flush time so re-flushes
   * of the same aggregate don't re-publish the same events.
   */
  pullDomainEvents(): DomainEvent[] {
    const out = this._domainEvents;
    this._domainEvents = [];
    return out;
  }

  /**
   * Identity equality: same concrete type and same id. Mirrors eShop's
   * `Entity.Equals` minus the transient-id branch (catalog ids are
   * natural keys assigned at construction, never DB-generated).
   */
  equals(other: unknown): boolean {
    if (this === other) return true;
    if (!(other instanceof Entity)) return false;
    if (this.constructor !== other.constructor) return false;
    return this.id === other.id;
  }
}
