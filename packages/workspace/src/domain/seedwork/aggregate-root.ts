/**
 * Marker interface: an aggregate root is the only kind of entity that
 * has a Repository. Mirrors eShop's `IAggregateRoot { }`
 * (Ordering.Domain/SeedWork/IAggregateRoot.cs)  empty by design,
 * purely a type-level marker.
 *
 * ## Why a marker, not behaviour
 *
 * "Aggregate root" is a *consistency-boundary* concept, not a
 * behaviour concept. The behaviour (id, domain events, equality)
 * lives on {@link Entity}, which every aggregate root extends.
 * `AggregateRoot` adds nothing at runtime; its only job is to let the
 * type system answer "may this type have a repository?" with a yes
 * (e.g. `abstract class Repository<T extends Entity & AggregateRoot>`).
 *
 * ## Convention
 *
 *   - An aggregate root: `class Workspace extends Entity implements AggregateRoot {}`
 *     and gets its own `WorkspaceRepository`.
 *   - A child entity: `class WorkspaceMember extends Entity {}` (no
 *     `implements AggregateRoot`)  accessed through the root, never
 *     via its own repository, even when it has its own SQL table.
 *   - A value object: extends `ValueObject` from seedwork; lives
 *     alongside its aggregate root in `domain/aggregates/<root>/`.
 *
 * Cross-context import rules: this marker may cross context
 * boundaries (it's a type, not behaviour). Aggregate-root *classes*
 * (e.g. `Workspace`) generally must NOT  peer contexts hold views
 * via {@link WorkspaceQueries}, not the aggregate.
 */
// biome-ignore lint/suspicious/noEmptyInterface: marker interface by design (mirrors eShop IAggregateRoot)
export interface AggregateRoot {}
