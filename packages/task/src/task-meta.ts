import type { Task } from "./types.js";

/**
 * Typed reader for the runtime metadata `TaskManager` deposits on
 * every task. All fields are `undefined` until the relevant lifecycle
 * event has been applied (e.g. `pid` is undefined before the start
 * event, `exitCode`/`exitSignal` before the exit watcher fires).
 *
 * The fields live in `task.metadata` (an open-shape bag the kernel
 * doesn't introspect). This helper centralises the strict typing so
 * runtime callers don't have to repeat the conditional narrowing.
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
