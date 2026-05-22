/**
 * Public API of `@emploke/__PKG__`.
 *
 * Single service per BC: `__Entity__Service` exposes both reads and
 * writes. Downstream packages depend on the concrete service (or a
 * narrower capability interface if they only need a subset).
 *
 * Construction: call `compose__Entity__Module({ dbFile })` once at
 * the composition root; never instantiate the service directly
 * outside of tests.
 *
 * The schema module (`__entity-kebab__-row` `*Row` types, drizzle
 * table object) is intentionally NOT re-exported. Those are
 * persistence implementation details — external consumers must go
 * through the DTO + service surface instead. See
 * `docs/pkg-template.md` "Repository contract" for the rationale.
 */

export { __Entity__Service } from "./__entity-kebab__-service.js";
export {
  type __Entity__Module,
  type __Entity__ModuleOptions,
  compose__Entity__Module,
} from "./compose.js";
export { __Entity__NotFoundError, Invalid__Entity__IdError } from "./errors.js";
export type {
  __Entity__,
  Create__Entity__Args,
  List__Entity__Opts,
} from "./types.js";
