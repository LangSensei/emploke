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
 */

/** Default time to wait for a contended lock before failing. */
const SETTINGS_LOCK_WAIT_MS = 5000;
/** Time after which an existing lock file is considered abandoned. */
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
 * Acquire an advisory lock on `lockPath`, run `fn`, then release. Same
 * semantics as the previous in-package implementation; kept here (rather
 * than depending on `@emploke/workspace`) so the runtime package's
 * dependency footprint stays minimal.
 */
async function withSettingsLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  while (true) {
    try {
      const fh = await open(lockPath, "wx");
      try {
        await fh.write(`${process.pid}\n`);
      } catch {}
      await fh.close();
      try {
        return await fn();
      } finally {
        try {
          await unlink(lockPath);
        } catch {}
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
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > SETTINGS_LOCK_STALE_MS) {
          try {
            await unlink(lockPath);
          } catch {}
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, SETTINGS_LOCK_POLL_MS));
    }
  }
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
