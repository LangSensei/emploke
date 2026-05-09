import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedSession } from "./types.js";

/** Filename written under each workdir to record per-session state. */
export const SESSION_FILE_NAME = "session.json";

/**
 * Bumped when the on-disk schema changes incompatibly. See the canonical
 * policy on `@emploke/workspace`'s `CURRENT_SCHEMA_VERSION` (jsdoc) for
 * bump criteria, mismatch behaviour, and migration strategy. The same
 * rules apply per entity.
 */
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
    return { ok: false, reason: schemaMismatchReason(obj.schemaVersion) };
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
 * Atomically write `session.json`. Writes to a uniquely-suffixed tmp file
 * first, then renames into place — readers either see the old file or the
 * new one, never a half-written file (assuming POSIX rename semantics;
 * Windows provides the same guarantee since Node.js 18).
 *
 * The tmp filename includes pid + 8 random hex chars so two concurrent
 * writers (e.g. two dashboard tabs both calling `list()`, each lazy-minting
 * a refresh) cannot clobber each other's tmp file or trigger an ENOENT on
 * rename when the second writer's tmp gets renamed away by the first.
 */
export async function writePersistedSession(
  workdir: string,
  value: PersistedSession,
): Promise<void> {
  const file = path.join(workdir, SESSION_FILE_NAME);
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, json, "utf8");
  try {
    await rename(tmp, file);
  } catch (err) {
    // Best-effort cleanup so we don't leave orphan tmp files behind on
    // failure. Ignore the unlink error itself — the original error is what
    // the caller needs to see.
    try {
      await unlink(tmp);
    } catch {}
    throw err;
  }
}

/**
 * Build a direction-aware rejection message for a schemaVersion mismatch.
 * See `@emploke/task`'s `schemaMismatchReason` for the rationale.
 */
function schemaMismatchReason(onDisk: unknown): string {
  if (typeof onDisk === "number" && Number.isFinite(onDisk)) {
    if (onDisk > CURRENT_SCHEMA_VERSION) {
      return `session.json was written by a newer emploke (schemaVersion ${onDisk}; this server supports ${CURRENT_SCHEMA_VERSION}). Upgrade the server to read it.`;
    }
    if (onDisk < CURRENT_SCHEMA_VERSION) {
      return `session.json was written by an older emploke (schemaVersion ${onDisk}; this server supports ${CURRENT_SCHEMA_VERSION}). Migration from older versions is not yet implemented.`;
    }
  }
  return `unsupported schemaVersion: ${JSON.stringify(onDisk)}`;
}
