/**
 * Public API of `@emploke/__PKG__`.
 *
 * Two surfaces:
 *   - `__Entity__Service` — writes (create / update / delete)
 *   - `__Entity__Queries` — reads (list / get / lookup)
 *
 * Downstream packages should depend on `__Entity__Queries` (or a
 * narrower capability interface) rather than `__Entity__Service`.
 *
 * Construction: call `compose__Entity__Module({ dbFile })` once at
 * the composition root; never instantiate the service / queries
 * classes directly outside of tests.
 */

export {
  type __Entity__Module,
  type __Entity__ModuleOptions,
  compose__Entity__Module,
} from "./compose.js";
export { __Entity__NotFoundError, Invalid__Entity__IdError } from "./errors.js";
export { __Entity__Queries } from "./queries.js";
export * as schema from "./schema.js";
export { __Entity__Service } from "./service.js";
export type {
  __Entity__,
  Create__Entity__Args,
  List__Entity__Opts,
} from "./types.js";
