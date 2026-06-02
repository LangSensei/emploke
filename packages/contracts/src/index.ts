/**
 * Public surface of `@emploke/contracts`.
 *
 * Pure types + leaf path helpers only. No orchestration, no DB handles,
 * no subprocess spawning. Safe for the SPA bundle and the CLI alike.
 *
 * Re-exports are grouped by source file rather than by category so the
 * "where does `Foo` live?" answer is one `Get-ChildItem` away. The
 * cross-pkg re-exports in `./domain.ts` cover T0/T1 domain types
 * (`Agent`, `Skill`, `Schedule`, etc.) so consumers never need a
 * workspace dep on the source pkg.
 */

export * from "./domain.js";
export * from "./health.js";
export * from "./plan-to-manifest.js";
export * from "./routes.js";
export * from "./runtimes.js";
export * from "./schedules.js";
export * from "./server-config.js";
