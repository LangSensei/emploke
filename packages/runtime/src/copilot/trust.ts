import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { TrustRegistrationFailed } from "./errors.js";

/** Max size (10MB) for the trust config file. Anything bigger is rejected. */
const MAX_CONFIG_BYTES = 10 * 1024 * 1024;

/**
 * Persistence + concurrency for `~/.copilot/config.json.trustedFolders`.
 *
 * # Why `config.json` and not `settings.json`?
 *
 * The Copilot CLI exposes two top-level user files in `~/.copilot/`:
 *
 *   - `settings.json` — documented "user settings" (logLevel, model, …).
 *     It happens to also accept a `trustedFolders` field syntactically,
 *     but the CLI **silently ignores** it for trust-gate decisions.
 *
 *   - `config.json` — leading comment says "managed automatically", which
 *     makes it look off-limits for hand-edits. It is in fact the ONLY
 *     file the CLI reads `trustedFolders` from. Verified empirically
 *     against Copilot CLI 1.0.44 by writing identical entries to both
 *     files and observing that only the `config.json` entry suppressed
 *     the "Confirm folder trust" prompt in `-i` mode.
 *
 * Using `config.json` is therefore both correct and stable. The previous
 * implementation wrote to `settings.json`, which was a no-op for the
 * trust gate — hence issue #38's report that interactive sessions still
 * showed the trust prompt despite "registration succeeding".
 *
 * # When this runs (lazy, per-launch)
 *
 * `ensureDirTrusted` is called from `CopilotRuntime.buildInteractiveLaunch` as a
 * pre-launch preflight, NOT from a workspace-bootstrap hook. The first
 * interactive launch in a workspace pays one read+write of `config.json`;
 * every subsequent launch hits the "already covered" early return after
 * a single read. That keeps `trustedFolders` O(workspaces) (one entry
 * per workspace via ancestor coverage) and means workspaces that are
 * only used for SDK-headless tasks never touch the file.
 *
 * # Why Copilot-only
 *
 * The whole module is intentionally Copilot-specific. Trust is not
 * lifted into the cross-runtime `Runtime` interface; each runtime
 * adapter owns its own preconditions and decides where to enforce them.
 * A future Gemini or Claude-Code adapter would write its own helper, or
 * none at all, depending on what its CLI requires.
 *
 * # IO mechanics
 *
 * The atomic-write + cross-process lock primitives come from two
 * focused npm libraries:
 *   - `write-file-atomic` — write-temp + rename, so concurrent
 *     buildInteractiveLaunch preflights from multiple dashboard
 *     sessions cannot partially write `config.json`.
 *   - `proper-lockfile` — PID-aware advisory lock with stale
 *     recovery, used to serialise the read-modify-write of
 *     `trustedFolders` so two concurrent preflights cannot both
 *     pass `isPathCovered` before either writes (lose-update).
 */

/**
 * Make sure `dir` is covered by `<configPath>.trustedFolders` so the
 * spawned interactive Copilot CLI (`-i`, see `buildInteractiveLaunch`) does not
 * interrupt the user with a per-folder trust prompt.
 *
 * `configPath` is normally `~/.copilot/config.json` — see the module
 * jsdoc for why this file (and not `settings.json`) is the correct
 * authority for `trustedFolders`. The SDK-headless mode used by
 * `launchCopilotHeadless` has no folder-trust gate (the SDK's
 * `approveAll` permission handler bypasses it) and therefore does
 * NOT call this function.
 *
 * Coverage rules (see `isPathCovered`):
 *   - exact match on the resolved absolute path counts as trusted
 *   - any ancestor directory listed in `trustedFolders` counts as trusted
 *
 * Concurrency: the entire read-modify-write sequence runs under a
 * `proper-lockfile` advisory lock on `<configPath>`. Without the
 * lock, two concurrent buildInteractiveLaunch preflights could both
 * pass `isPathCovered` before either wrote, then the second
 * `write-file-atomic` would clobber the first writer's unrelated
 * changes.
 *
 * Failure modes — every failure path (mkdir, lock timeout, atomic
 * write, parent permissions) is wrapped as {@link TrustRegistrationFailed}.
 * That gives `buildInteractiveLaunch` a single, typed catch surface
 * and preserves the underlying error message (which for a
 * `proper-lockfile` timeout includes the holder PID — the operator's
 * only handle to a wedged trust write).
 *
 * If `dir` (or an ancestor) is already covered, the file is left untouched.
 * A missing or unparseable config file is treated as "start fresh"; we
 * never refuse to launch because the user's config is corrupted (that
 * would block the very first session on a new install).
 */
export async function ensureDirTrusted(dir: string, configPath: string): Promise<void> {
  const resolvedDir = path.resolve(dir);

  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    // proper-lockfile requires the locked file to exist. Touch it
    // only when it's genuinely missing — any other stat failure
    // (EACCES, EIO, EISDIR, …) must propagate. The earlier shape
    // had a bare `catch` here which would silently overwrite the
    // user's real `config.json` with `{}` if (say) the file was
    // present but unreadable for permissions reasons. Data loss.
    try {
      await stat(configPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await writeFileAtomic(configPath, "{}");
    }
    const release = await lockfile.lock(configPath, {
      retries: { retries: 100, factor: 1.1, minTimeout: 50, maxTimeout: 200 },
      stale: 30000,
    });
    try {
      // Read + parse phase. Failure modes split into two outcomes:
      //   - file missing / file unreadable as JSON  -> "start fresh"
      //     (rewrite below with just `trustedFolders`, valid file).
      //   - file present but exceeds MAX_CONFIG_BYTES -> HARD REFUSE
      //     (do NOT clobber a 100MB user config with `{}` just
      //     because we hit the cap). The size check therefore lives
      //     OUTSIDE the swallow-and-start-fresh catch below.
      const st = await statSafe(configPath);
      if (st !== null && st.size > MAX_CONFIG_BYTES) {
        throw new Error(
          `refusing to touch ${configPath}: ${st.size} bytes exceeds cap of ${MAX_CONFIG_BYTES}`,
        );
      }

      let config: Record<string, unknown> = {};
      if (st !== null) {
        try {
          const raw = await readFile(configPath, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            config = parsed as Record<string, unknown>;
          }
        } catch {
          // Invalid JSON — start fresh. We never refuse to launch
          // because the user's config is corrupted; the rewrite
          // below will produce a valid file containing just
          // `trustedFolders`.
        }
      }

      const existing = readTrustedFolders(config.trustedFolders);
      if (isPathCovered(resolvedDir, existing)) return;

      config.trustedFolders = [...existing, resolvedDir];
      await writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
    } finally {
      await release();
    }
  } catch (cause) {
    throw new TrustRegistrationFailed(configPath, resolvedDir, cause as Error);
  }
}

/** stat or null-on-ENOENT. Other stat errors propagate. */
async function statSafe(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await stat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
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
