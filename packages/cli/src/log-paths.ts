/**
 * Resolve the latest server log file under `<EMPLOKE_HOME>/logs/`.
 *
 * Server logs are written via `pino-roll`, which writes to
 * `<basename>` and rotates daily into `<basename>.YYYY-MM-DD` (and
 * `<basename>.YYYY-MM-DD.N` once the size cap kicks in). The current
 * file might be the bare basename (just-rotated, no suffix yet) or any
 * of the dated suffixes — picking "most-recently-modified" handles
 * every layout pino-roll has ever produced without baking the suffix
 * pattern into the CLI.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Return the absolute path to the newest file matching `<basename>` or
 * `<basename>.*` in `logsDir`. Returns `null` when the directory is
 * absent or holds no matching files (the steady state before the
 * server has ever been started).
 */
export async function resolveLatestLog(
  logsDir: string,
  basename = "server",
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const matching = entries.filter((e) => e === basename || e.startsWith(`${basename}.`));
  if (matching.length === 0) return null;

  let best: { name: string; mtimeMs: number } | null = null;
  for (const name of matching) {
    const full = path.join(logsDir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { name, mtimeMs: st.mtimeMs };
      }
    } catch {
      // Race with rotation: a sibling file we listed may already be
      // gone. Skip and keep scanning.
    }
  }

  return best ? path.join(logsDir, best.name) : null;
}
