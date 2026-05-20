/**
 * Catalog seedwork — the domain primitives shared by every aggregate
 * in `@emploke/catalog`. Each bounded context owns its own copy
 * (see ADR-8); do NOT import from `@emploke/workspace/seedwork`.
 */

export type { AggregateRoot } from "./aggregate-root.js";
export { Entity } from "./entity.js";
export { ValueObject } from "./value-object.js";
