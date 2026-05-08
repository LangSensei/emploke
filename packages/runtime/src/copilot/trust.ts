import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { TrustRegistrationFailed } from "./errors.js";

/**
 * Persistence + concurrency for `~/.copilot/settings.json.trustedFolders`.
 *
 * Splitting this out of `provision.ts` reflects the new design: trust is a
 * **workspace-level** concern, not a per-session one. The Copilot runtime
 * calls `ensureDirTrusted` once per workspace at registration time; per
 * session no longer touches `settings.json` at all. The result is one
 * `trustedFolders` entry per workspace instead of one per session.
 *
 * Concurrency, atomicity and "covered-by-ancestor" matching all behave
 * exactly as the previous `ensureWorkdirTrusted` did — only the call site
 * and the meaning of the path argument have changed.
 *
 * Note: the lock implementation here is intentionally a sibling of the one
 * in `@emploke/workspace`'s `atomic.ts` (same PID-guard hardening). The
 * two are kept in sync by hand to avoid a `runtime → workspace` dependency.
 * If a third caller appears, factor both into a shared `@emploke/fs-utils`.
 */

/** Default time to wait for a contended lock before failing. */
const SETTINGS_LOCK_WAIT_MS = 5000;
/**
 * Time after which an existing lock file is *eligible* for stale-recovery
 * via mtime alone. Even past this threshold we still try a PID liveness
 * check first; the mtime threshold is the fallback for the case where the
 * holder PID could not be parsed.
 */
const SETTINGS_LOCK_STALE_MS = 30000;
/** Poll interval while waiting on a contended lock. */
const SETTINGS_LOCK_POLL_MS = 50;

/**
 * Make sure `dir` is covered by `<settingsPath>.trustedFolders` so the
 * spawned Copilot CLI does not interrupt the user with a per-folder trust
 * prompt.
 *
 * Coverage rules (see `isPathCovered`):
 *   - exact match on the resolved absolute path counts as trusted
 *   - any ancestor directory listed in `trustedFolders` counts as trusted
 *
 * Concurrency: the entire read-modify-write sequence runs under a
 * `<settingsPath>.lock` file (`O_EXCL` create-or-fail, with stale-lock
 * recovery). Without the lock, two concurrent registerWorkspace calls
 * could both pass `isPathCovered` before either wrote, then the second
 * `rename()` would clobber the first writer's unrelated changes.
 *
 * If `dir` (or an ancestor) is already covered, the file is left untouched.
 * A missing or unparseable settings file is treated as "start fresh"; we
 * never refuse to register a workspace because the user's settings are
 * corrupted (that would block the very first session on a new install).
 */
export async function ensureDirTrusted(dir: string, settingsPath: string): Promise<void> {
  const resolvedDir = path.resolve(dir);

  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
  } catch (cause) {
    throw new TrustRegistrationFailed(settingsPath, resolvedDir, cause as Error);
  }

  await withSettingsLock(`${settingsPath}.lock`, async () => {
    let settings: Record<string, unknown> = {};
    try {
      const raw = await readFile(settingsPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // ENOENT or invalid JSON — fall through with `settings = {}`.
    }

    const existing = readTrustedFolders(settings.trustedFolders);
    if (isPathCovered(resolvedDir, existing)) return;

    settings.trustedFolders = [...existing, resolvedDir];

    try {
      const tmp = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      await rename(tmp, settingsPath);
    } catch (cause) {
      throw new TrustRegistrationFailed(settingsPath, resolvedDir, cause as Error);
    }
  });
}

/**
 * Acquire an advisory lock on `lockPath`, run `fn`, then release.
 *
 * Stale-recovery is conservative: if we can read a PID from the existing
 * lock file and `process.kill(pid, 0)` does not throw, we never steal —
 * even if the file is older than `SETTINGS_LOCK_STALE_MS`. Only when the
 * holder PID is dead, unparseable, or absent AND the file is past the
 * mtime threshold do we evict and retry.
 *
 * Release only `unlink`s the file if its contents still match our PID.
 * That guards the (now narrow) race where a long-running `fn()` was
 * evicted by a waiter that decided we were stale; we must not then
 * delete the new owner's lock.
 */
async function withSettingsLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const myMarker = `${process.pid}\n`;
  while (true) {
    try {
      const fh = await open(lockPath, "wx");
      try {
        await fh.write(myMarker);
      } catch {}
      await fh.close();
      try {
        return await fn();
      } finally {
        await releaseIfMine(lockPath, myMarker);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      if (Date.now() - start > SETTINGS_LOCK_WAIT_MS) {
        const holder = await readLockHolder(lockPath);
        const detail = holder !== null ? ` (held by PID ${holder})` : "";
        throw new Error(
          `timed out (${SETTINGS_LOCK_WAIT_MS}ms) acquiring lock on ${lockPath}${detail}`,
        );
      }

      if (await tryStealStaleLock(lockPath)) continue;
      await new Promise((resolve) => setTimeout(resolve, SETTINGS_LOCK_POLL_MS));
    }
  }
}

/**
 * Inspect the lock file and `unlink` it iff it is safely stealable.
 * Returns true if the caller should immediately retry acquisition.
 *
 * Order of checks:
 *   1. Holder PID readable AND alive → never steal (long-running fn).
 *   2. Holder PID readable AND dead (ESRCH) → steal regardless of mtime.
 *   3. PID unparseable AND mtime past `SETTINGS_LOCK_STALE_MS` → steal.
 *   4. Otherwise leave alone; let the poll loop wait.
 */
async function tryStealStaleLock(lockPath: string): Promise<boolean> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(lockPath);
  } catch {
    // Lock file vanished between EEXIST and stat — race; retry now.
    return true;
  }
  const holder = await readLockHolder(lockPath);
  if (holder !== null) {
    if (isProcessAlive(holder)) return false;
    await unlinkIgnoreMissing(lockPath);
    return true;
  }
  if (Date.now() - st.mtimeMs > SETTINGS_LOCK_STALE_MS) {
    await unlinkIgnoreMissing(lockPath);
    return true;
  }
  return false;
}

async function releaseIfMine(lockPath: string, expectedMarker: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return;
  }
  if (raw === expectedMarker) {
    await unlinkIgnoreMissing(lockPath);
  }
  // else: another waiter took ownership; do not touch.
}

async function unlinkIgnoreMissing(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch {}
}

/** Best-effort read of the PID written by the current lock holder. */
async function readLockHolder(lockPath: string): Promise<number | null> {
  try {
    const raw = (await readFile(lockPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * `process.kill(pid, 0)` returns nothing on success and throws ESRCH if
 * the pid is dead. EPERM means "exists but I don't own it" — treat as
 * alive. Any other error: be conservative and assume alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

/**
 * Coerce the raw `trustedFolders` value into a string array, dropping
 * non-string entries silently. We accept whatever shape the file currently
 * has (Copilot CLI may evolve the schema) but rewrite as plain `string[]`.
 */
function readTrustedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string");
}

/**
 * Returns true iff `target` is the same as, or nested inside, any directory
 * listed in `trusted`. Comparison happens on `path.resolve`-d strings.
 *
 * Boundary check uses `path.sep` so `/foo` does NOT cover `/foobar`.
 */
export function isPathCovered(target: string, trusted: readonly string[]): boolean {
  const normTarget = path.resolve(target);
  for (const entry of trusted) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const normEntry = path.resolve(entry);
    if (normEntry === normTarget) return true;
    const prefix = normEntry.endsWith(path.sep) ? normEntry : normEntry + path.sep;
    if (normTarget.startsWith(prefix)) return true;
  }
  return false;
}
