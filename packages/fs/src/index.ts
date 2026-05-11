/**
 * @emploke/fs — filesystem primitives shared across the codebase.
 *
 * Pure mechanics, zero entity knowledge: atomic write, cross-process
 * lock, raw JSON read, ENOENT-tolerant fs helpers. Used by every
 * `Fs*Repository` implementation, plus any other adapter that needs
 * the same primitives (e.g. Copilot trust file maintenance in
 * `@emploke/runtime`).
 *
 * Boundary rule: this package depends on nothing but `node:fs` /
 * `node:crypto`. Anyone in the workspace may depend on it without
 * worrying about layering — by construction it cannot pull anything
 * else along. A future SQLite swap is a matter of adding sibling
 * `Sqlite*Repository` classes in each entity package; this primitive
 * layer stays untouched because SQLite implementations don't go
 * through it.
 */

export {
  replaceDirAtomic,
  writeFileAtomic,
  writeJsonAtomic,
} from "./primitives/atomic.js";
export {
  DEFAULT_READ_JSON_MAX_BYTES,
  JsonFileTooLargeError,
  type ReadJsonOpts,
  readJson,
} from "./primitives/json.js";
export {
  FsLockTimeoutError,
  type WithFileLockOpts,
  withFileLock,
} from "./primitives/lock.js";
export { mkdirP, safeReaddir, safeStat } from "./primitives/safe-fs.js";
