import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedSession } from "./types.js";

/** Filename written under each workdir to record per-session state. */
export const SESSION_FILE_NAME = "session.json";

/** Bumped when the on-disk schema changes incompatibly. */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Read and validate `<workdir>/session.json`. Returns the parsed record on
 * success, `null` if the file is missing, and throws `SessionCorruptedError`
 * if the file exists but cannot be interpreted (with a `reason` describing
 * what's wrong).
 *
 * The id parameter is used only for error messages.
 */
export async function readPersistedSession(
  workdir: string,
): Promise<{ ok: true; value: PersistedSession } | { ok: false; reason: string } | null> {
  const file = path.join(workdir, SESSION_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `json parse failed: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "expected an object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schemaVersion: ${JSON.stringify(obj.schemaVersion)}` };
  }
  if (typeof obj.runtime !== "string" || obj.runtime.length === 0) {
    return { ok: false, reason: "missing or invalid 'runtime'" };
  }
  if (typeof obj.createdAt !== "string" || obj.createdAt.length === 0) {
    return { ok: false, reason: "missing or invalid 'createdAt'" };
  }
  const rsid = obj.runtimeSessionId;
  if (rsid !== null && typeof rsid !== "string") {
    return { ok: false, reason: "'runtimeSessionId' must be string or null" };
  }
  return {
    ok: true,
    value: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      runtime: obj.runtime,
      createdAt: obj.createdAt,
      runtimeSessionId: rsid,
    },
  };
}

/**
 * Atomically write `session.json`. Writes to `session.json.tmp` first, then
 * renames into place — readers either see the old file or the new one,
 * never a half-written file (assuming POSIX rename semantics; Windows
 * provides the same guarantee since Node.js 18).
 */
export async function writePersistedSession(
  workdir: string,
  value: PersistedSession,
): Promise<void> {
  const file = path.join(workdir, SESSION_FILE_NAME);
  const tmp = `${file}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, json, "utf8");
  await rename(tmp, file);
}
