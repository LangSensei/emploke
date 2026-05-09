import { readFile } from "node:fs/promises";

/**
 * Read + parse JSON. Returns `null` if the file is missing.
 * Throws on parse failure (caller decides how to surface).
 *
 * Deliberately does NOT do schema validation — that is a Repository
 * concern. This primitive is "raw bytes -> any". Callers wrap it with
 * their entity-specific validation (typically per-package schema check
 * + typed Corrupted* error).
 */
export async function readJson<T = unknown>(absPath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw) as T;
}
