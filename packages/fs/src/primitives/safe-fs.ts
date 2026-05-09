import type { Stats } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";

/**
 * `readdir` that returns `[]` on ENOENT instead of throwing. Use when
 * the absence of a directory is a normal "no entries" outcome rather
 * than an error.
 */
export async function safeReaddir(absDir: string): Promise<string[]> {
  try {
    return await readdir(absDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * `stat` that returns `null` on ENOENT instead of throwing.
 */
export async function safeStat(absPath: string): Promise<Stats | null> {
  try {
    return await stat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * `mkdir -p`. Idempotent.
 */
export async function mkdirP(absDir: string): Promise<void> {
  await mkdir(absDir, { recursive: true });
}
