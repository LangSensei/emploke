/**
 * @emploke/storage — IO primitives shared across the entity packages.
 *
 * Two layers will eventually live here:
 *
 *   1. **Primitives** (this PR): atomic write, cross-process lock, raw
 *      JSON read, ENOENT-tolerant fs helpers. No knowledge of any
 *      entity. Used by every `Fs*Repository` implementation.
 *   2. **Repository interfaces** (deferred): per-entity Repository
 *      types live in their owning entity package (e.g. `TaskRepository`
 *      lives in `@emploke/task`), not here. This package stays purely
 *      about IO mechanics.
 *
 * The split keeps `@emploke/storage` zero-deps (just node fs + crypto)
 * and makes a future SQLite swap a matter of adding a sibling
 * `Sqlite*Repository` in each entity package — this primitive layer
 * stays untouched because SQLite implementations don't go through it.
 */

export {
  writeFileAtomic,
  writeJsonAtomic,
} from "./primitives/atomic.js";
export { readJson } from "./primitives/json.js";
export {
  StorageLockTimeoutError,
  type WithFileLockOpts,
  withFileLock,
} from "./primitives/lock.js";
export { mkdirP, safeReaddir, safeStat } from "./primitives/safe-fs.js";
