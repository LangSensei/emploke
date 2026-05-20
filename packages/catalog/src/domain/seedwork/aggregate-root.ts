/**
 * Marker interface: an aggregate root is the only kind of entity
 * that has a Repository. Mirrors eShop's `IAggregateRoot { }`
 * (`Ordering.Domain/SeedWork/IAggregateRoot.cs`) — empty by design,
 * purely a type-level marker.
 *
 * "Aggregate root" is a *consistency-boundary* concept, not a
 * behaviour concept. The behaviour (id, domain events, equality)
 * lives on {@link Entity}, which every aggregate root extends.
 * `AggregateRoot` adds nothing at runtime; its only job is to let
 * the type system answer "may this type have a repository?".
 *
 * ## Catalog conventions
 *
 *   - Aggregate roots: `Mcp`, `Skill`, `Agent`. Each gets its own
 *     repository (or, post-MikroORM-migration, its own MikroORM
 *     `EntityRepository`). The three are independent install units;
 *     cross-aggregate dependency invariants (e.g. "Agent.skills
 *     references existing Skill rows") are maintained by the
 *     application layer's install handler, not by a god aggregate.
 *   - Value objects: `SkillFqn` / `AgentFqn` / `McpName` / `Origin`
 *     extend {@link ValueObject} from seedwork.
 *
 * Cross-context import rules: this marker may cross context
 * boundaries (it's a type, not behaviour). Aggregate-root *classes*
 * generally must NOT — peer contexts hold projections via dedicated
 * `Queries` services rather than the aggregate.
 */
// biome-ignore lint/suspicious/noEmptyInterface: marker interface by design (mirrors eShop IAggregateRoot)
export interface AggregateRoot {}
