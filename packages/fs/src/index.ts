/**
 * @emploke/fs — filesystem + on-disk format primitives shared across
 * the codebase.
 *
 * Pure mechanics, zero entity knowledge: atomic write, cross-process
 * lock, raw JSON read, ENOENT-tolerant fs helpers, YAML frontmatter
 * patcher. Used by every `Fs*Repository` implementation, plus any
 * other adapter that needs the same primitives (e.g. Copilot trust
 * file maintenance in `@emploke/runtime`, skill metadata edits in
 * `@emploke/catalog`).
 *
 * Boundary rule: this package depends only on `node:*` and tiny
 * format utilities (js-yaml). Anyone in the workspace may depend on
 * it without worrying about layering — by construction it cannot
 * pull catalog/session/task/etc. along.
 */

export {
  replaceDirAtomic,
  writeFileAtomic,
  writeJsonAtomic,
} from "./primitives/atomic.js";
export { applyFrontmatterPatch } from "./primitives/frontmatter.js";
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
