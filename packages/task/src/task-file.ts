import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Task } from "./types.js";

/** Filename written under each task dir. */
export const TASK_FILE_NAME = "task.json";

/** Bumped when the on-disk schema changes incompatibly. */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * On-disk record. The Task FSM is the source of truth — runtime
 * bookkeeping (workdir, runtime kind, runtimeSessionId, pid, exit info)
 * lives in `task.metadata` per the kernel convention; nothing here is
 * stored at top level twice.
 */
export interface PersistedTask {
  readonly schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  readonly task: Task;
}

/**
 * Read and validate `<taskDir>/task.json`.
 *
 * Returns `null` when the file is missing (i.e. this is not a task dir),
 * `{ ok: false, reason }` when the file exists but cannot be interpreted
 * (corrupted, wrong schema), and `{ ok: true, value }` on success.
 *
 * Validation is structural only: schema version must match exactly, and
 * the embedded task must look Task-shaped enough that `apply()` won't
 * blow up at runtime. Deeper invariants are the kernel's responsibility.
 */
export async function readPersistedTask(
  taskDir: string,
): Promise<{ ok: true; value: PersistedTask } | { ok: false; reason: string } | null> {
  const file = path.join(taskDir, TASK_FILE_NAME);
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
  const task = obj.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return { ok: false, reason: "missing or invalid 'task' field" };
  }
  const t = task as Record<string, unknown>;
  if (typeof t.id !== "string" || t.id.length === 0) {
    return { ok: false, reason: "task.id must be a non-empty string" };
  }
  if (typeof t.agent !== "string") {
    return { ok: false, reason: "task.agent must be a string" };
  }
  if (typeof t.instructions !== "string") {
    return { ok: false, reason: "task.instructions must be a string" };
  }
  if (typeof t.status !== "string") {
    return { ok: false, reason: "task.status must be a string" };
  }
  if (typeof t.createdAt !== "string") {
    return { ok: false, reason: "task.createdAt must be a string" };
  }
  if (!t.metadata || typeof t.metadata !== "object" || Array.isArray(t.metadata)) {
    return { ok: false, reason: "task.metadata must be an object" };
  }
  return {
    ok: true,
    value: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      task: task as Task,
    },
  };
}

/**
 * Atomically write `task.json`. Writes to a uniquely-suffixed tmp file
 * first, then renames into place — readers either see the old file or
 * the new one, never a half-written file. Same protocol as
 * `@emploke/session`'s session-file writer.
 *
 * The tmp filename includes pid + 8 random hex chars so two concurrent
 * writers (e.g. dispatch + an exit watcher firing during a list call)
 * cannot clobber each other's tmp file.
 *
 * On Windows, the rename can race with a reader on the destination
 * (`MoveFileEx` returns EPERM/EACCES if any process has the dest open
 * even briefly without share-delete). The dashboard polls `task.json`
 * repeatedly while a task runs, so this race is real and observable.
 * We retry the rename a few times with a tiny backoff before giving up
 * — the contention window is microseconds.
 */
export async function writePersistedTask(taskDir: string, value: PersistedTask): Promise<void> {
  const file = path.join(taskDir, TASK_FILE_NAME);
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, json, "utf8");
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {}
    throw err;
  }
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_MAX_ATTEMPTS = 8;

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== undefined && RENAME_RETRY_CODES.has(code)) {
        lastErr = err;
        // Exponential-ish backoff capped low: 1, 2, 4, 8, 16, 32, 32, 32 ms.
        const delayMs = Math.min(32, 1 << attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Typed reader for the runtime metadata `TaskManager` deposits on every
 * task. All fields are `undefined` until the relevant lifecycle event
 * has been applied (e.g. `pid` is undefined before the start event,
 * `exitCode`/`exitSignal` before the exit watcher fires).
 *
 * Returns `null` for the (rare) case of a Task whose metadata isn't an
 * object at all — defensive, in case some external producer creates a
 * Task without going through `TaskManager`.
 */
export interface TaskRuntimeMetadata {
  readonly workdir?: string;
  readonly runtime?: string;
  readonly runtimeSessionId?: string;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly exitSignal?: NodeJS.Signals | null;
}

export function readTaskRuntimeMetadata(task: Task): TaskRuntimeMetadata {
  const m = task.metadata;
  if (!m || typeof m !== "object") return {};
  const out: TaskRuntimeMetadata = {};
  if (typeof m.workdir === "string") (out as { workdir?: string }).workdir = m.workdir;
  if (typeof m.runtime === "string") (out as { runtime?: string }).runtime = m.runtime;
  if (typeof m.runtimeSessionId === "string")
    (out as { runtimeSessionId?: string }).runtimeSessionId = m.runtimeSessionId;
  if (typeof m.pid === "number") (out as { pid?: number }).pid = m.pid;
  if (typeof m.exitCode === "number" || m.exitCode === null)
    (out as { exitCode?: number | null }).exitCode = m.exitCode as number | null;
  if (typeof m.exitSignal === "string" || m.exitSignal === null)
    (out as { exitSignal?: NodeJS.Signals | null }).exitSignal =
      m.exitSignal as NodeJS.Signals | null;
  return out;
}
