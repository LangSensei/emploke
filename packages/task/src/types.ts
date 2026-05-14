/**
 * Domain types for @emploke/task.
 *
 * The `Task` entity itself lives in {@link ./task-entity.ts} (DDD class
 * with `static fromStored()` / `static create()` plus state-transition
 * methods `start` / `complete` / `fail` / `cancel` — mirrors the
 * `@emploke/catalog` Agent pattern). This file holds the supporting
 * value types: status enum, result / failure shapes, and `TaskManager`
 * configuration. They're deliberately plain interfaces — they're
 * either exhaustive enums (`TaskStatus`), value-only payloads
 * (`TaskResult`, `TaskFailure`), or constructor-options bags
 * (`TaskManagerConfig`) where DDD adds no leverage.
 *
 * Why metadata instead of named fields on Task:
 *  - The Task type never has to change when a new runtime arrives.
 *  - SDK runtimes (no PID), serverless runtimes (no work dir), and
 *    classic CLI runtimes can all coexist.
 *  - Mirrors the kernel `Capability.Metadata` convention from the Go
 *    archive — emploke "stores but never reads" runtime metadata.
 */

import type { CatalogManager } from "@emploke/catalog";
import type { RuntimeRegistry } from "@emploke/runtime";

/**
 * Status lifecycle: `not_started → running → success | failure | cancelled`.
 *
 * Note on `cancelled`: `Task.cancel()` accepts the transition from both
 * `not_started` and `running`, but `TaskManager` does not currently
 * call it. A subprocess killed during `delete()` has its workdir
 * removed before any terminal event is applied; a subprocess killed
 * during `shutdown()` is recorded as `failure` with reason "server
 * shutdown". The `cancelled` status is therefore reserved for a future
 * user-cancel API (e.g. `TaskManager.cancel(id)` + a `POST .../cancel`
 * route) that lets users distinguish "I asked it to stop" from "it
 * crashed". The dashboard already renders a `Cancelled` label so the
 * UI need not change when that API arrives.
 */
export type TaskStatus = "not_started" | "running" | "success" | "failure" | "cancelled";

/** A status from which no further transitions are legal. */
export type TerminalStatus = "success" | "failure" | "cancelled";

/**
 * Result attached when a Task transitions to `success`.
 *
 * `output` semantics under the current **runtime-driven completion model**:
 * the kernel does not interpret what an autonomous agent produced. The
 * substantive output of an agent run lives on the filesystem under
 * `Task.metadata.workdir/` — agent-written files and the captured
 * `stderr.log`. The runtime's per-task event stream lives on the
 * runtime's own state directory (e.g.
 * `<copilotStateDir>/<runtimeSessionId>/events.jsonl`) and is read
 * via `Runtime.readActivity` rather than mirrored into the workdir.
 * The `output` string is intentionally minimal and may be empty:
 * today `TaskManager` always writes `""` here. A future, agent-driven
 * completion model (where the agent submits a structured deliverable
 * summary back to the kernel) would carry that summary in this field;
 * the kernel shape is pre-positioned for it.
 */
export interface TaskResult {
  readonly output: string;
}

export interface TaskFailure {
  readonly error: string;
}

// ─── TaskManager-side types ───────────────────────────────────

import type { Logger } from "@emploke/logger";
import type { TaskRepository } from "./repositories/repository.js";

/** Constructor options for `TaskManager`. */
export interface TaskManagerConfig {
  readonly catalog: CatalogManager;
  readonly runtimeRegistry: RuntimeRegistry;
  /** Absolute path to the directory holding per-task workdirs. */
  readonly tasksDir: string;
  /**
   * Absolute path of the workspace this manager belongs to. Threaded
   * to `runtime.dispatchTask` as `workspaceDir` so MCP placeholder
   * substitution at provision-time can resolve `${workspaceDir}` to a
   * path that is shared across every session/task in this workspace.
   */
  readonly workspaceDir: string;
  /**
   * Workspace UUID this manager belongs to. Surfaced as
   * `EMPLOKE_WORKSPACE` in every task subprocess's env so the spawned
   * binary (and any of its own children) can address its workspace
   * over the API without the caller threading `--workspace` through
   * every invocation.
   *
   * Optional for back-compat with existing tests that build a
   * `TaskManager` without a real workspace registration; production
   * call sites in `WorkspaceContext` always pass it.
   */
  readonly workspaceId?: string;
  /**
   * Static env overrides merged into every task subprocess on top of
   * the per-task additions assembled in `dispatch()`. Production wires
   * this from the server with `EMPLOKE_SERVER` and `EMPLOKE_SHARED_DIR`
   * so the spawned CLI can call back into the same server it was
   * launched from and write to the machine-shared dir. Tests typically
   * leave this unset.
   */
  readonly subprocessEnv?: NodeJS.ProcessEnv;
  /** Default runtime kind to use when `dispatch` doesn't override. */
  readonly defaultRuntime?: string;
  /**
   * Persistence backend for task state. Required: callers (server
   * `WorkspaceContext` in production, tests) construct a
   * `SqliteTaskRepository({ db: <workspace.db connection> })` and pass
   * it. There is no default — the task pkg no longer owns a DB file
   * path; the workspace pkg does.
   */
  readonly repository: TaskRepository;
  readonly logger?: Logger;
  /** Test seam: clock injection. */
  readonly now?: () => Date;
  /** Test seam: random source for id generation. */
  readonly randomBytes?: (n: number) => Buffer;
  /**
   * Optional override for the per-runtime framing prompt map (issue #109).
   *
   * Production omits this and gets the package default
   * (`{ copilot: TASK_FRAMING_PROMPT_COPILOT }`). Tests that drive
   * dispatch with a stub runtime kind (e.g. `gemini`, `node-test`)
   * pass a map containing those kinds so dispatch can resolve a
   * prompt without modifying production constants.
   *
   * If a non-empty map is supplied, the manager looks up runtime
   * kinds **only** in this map and ignores the default. This keeps
   * test isolation explicit: a test that registers `gemini` here
   * doesn't accidentally inherit `copilot` mappings.
   */
  readonly framingPromptByRuntime?: Readonly<Record<string, string>>;
}

/** Inputs to `TaskManager.dispatch`. */
export interface DispatchOpts {
  /** Catalog name of the agent to run. Required. */
  readonly agent: string;
  /** Free-form prompt / instructions for the agent. */
  readonly instructions: string;
  /** Override the configured `defaultRuntime`. */
  readonly runtime?: string;
}

/**
 * Options for `TaskManager.list`. Mirrors the shape of
 * `@emploke/session`'s `ListSessionOpts` so callers see a consistent
 * filter API across the two managers.
 *
 * Filters are applied server-side by the SQLite repository's indexed
 * columns; the manager just forwards them. This keeps server routes
 * able to push their filter inputs down so the dashboard never
 * serialises rows it'd discard.
 */
export interface ListTaskOpts {
  /** Filter to tasks whose `agent` matches this exact value. */
  readonly agent?: string;
  /**
   * Drop tasks whose `createdAt` is strictly before this ISO 8601
   * timestamp. ISO 8601 strings (Z-suffixed) sort lexicographically as
   * dates, so the comparison is a plain string `<`.
   */
  readonly createdSince?: string;
  /**
   * Filter to tasks whose `metadata.runtime` matches this exact value.
   * Useful for the dashboard's runtime dropdown filter.
   */
  readonly runtime?: string;
  /**
   * Filter to tasks in one of the listed statuses. The dashboard uses
   * this for the auto-poll path (`status=running`) so the server can
   * answer "do I have anything still in flight?" without serialising
   * every terminal task.
   */
  readonly statuses?: readonly TaskStatus[];
}
