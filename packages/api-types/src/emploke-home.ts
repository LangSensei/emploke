import { homedir } from "node:os";
import path from "node:path";

/** Fallback `~/.emploke` when no `EMPLOKE_HOME` env var is set. */
export const DEFAULT_EMPLOKE_HOME: string = path.join(homedir(), ".emploke");

/**
 * Resolve the emploke home directory from environment. Pure: no fs
 * access. Empty-string overrides (`EMPLOKE_HOME=""`) are treated as
 * unset.
 */
export function resolveEmplokeHome(env: NodeJS.ProcessEnv = {}): string {
  const homeOverride = env.EMPLOKE_HOME;
  return path.resolve(
    homeOverride && homeOverride.length > 0 ? homeOverride : DEFAULT_EMPLOKE_HOME,
  );
}

/**
 * Filename (under `<home>`) for the CLI lifecycle breadcrumb. Written
 * by `emploke start`, read by `emploke status` / `stop` / `connect`,
 * deleted by `emploke stop`. Records pid + host + port of the running
 * server so a later CLI invocation can find and talk to it.
 */
export const RUNTIME_FILE_NAME = "runtime.json";

/**
 * Persisted shape of `<home>/runtime.json`. Server writes; CLI reads.
 * The breadcrumb is an out-of-band IPC contract — alongside HTTP, this
 * is how the CLI finds a running server.
 */
export interface RuntimeFile {
  /** Schema version — bump on breaking changes. */
  readonly schema: 1;
  /** Pid of the detached server process. */
  readonly pid: number;
  /** Bind host (mirrors `EMPLOKE_HOST` passed to `start`). */
  readonly host: string;
  /** Listening port (mirrors `PORT` passed to `start`). */
  readonly port: number;
  /** ISO 8601 timestamp captured at `start` time. */
  readonly startedAt: string;
  /** Argv the spawned child saw, captured for diagnostics. */
  readonly serverArgs: readonly string[];
}

/** Resolve `<home>/runtime.json`. */
export function runtimeFilePath(home: string): string {
  return path.join(home, RUNTIME_FILE_NAME);
}

/** Subdirectory (under `<home>`) where the server writes rotated log files. */
export const LOGS_SUBDIR = "logs";

/** Resolve `<home>/logs/`. */
export function logsDir(home: string): string {
  return path.join(home, LOGS_SUBDIR);
}
