/**
 * Source-of-`now()` for the workspace pkg. Injected into command
 * handlers so test code can pin time without monkey-patching `Date`.
 *
 * Declared in the workspace pkg because it is the first DDD consumer
 * of the DI-based clock pattern (issue #135 Phase 1). Once a second
 * package needs the same injection seam (session / task / catalog as
 * they're refactored in Phases 3-5), promote `Clock` to a shared
 * package (e.g. a new `@emploke/common` or `@emploke/clock`). Until
 * then importing `Clock` from `@emploke/workspace` is acceptable
 * cross-context usage per naming-conventions §8.3 (other pkgs may
 * import this package's domain primitives).
 *
 * Abstract class (not TS `interface`) per naming-conventions §3 —
 * one name doubles as the compile-time type and the inversify DI
 * token.
 */
export abstract class Clock {
  /** Current instant as an ISO-8601 UTC string. */
  abstract nowIso(): string;
}
