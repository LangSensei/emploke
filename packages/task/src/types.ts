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
 * `cancelled` is produced by `TaskManager.cancel(id)` (the user-initiated
 * verb introduced in ADR-001). `Task.cancel()` still accepts the
 * transition from both `not_started` and `running` so a future queueing
 * layer can cancel a not-yet-dispatched entry; today the Manager only
 * ever sees `running` cancellations (dispatch immediately transitions
 * to running before the first save). `failure` covers everything else
 * the subprocess might do — crashing, exiting non-zero, getting
 * SIGTERM'd by `shutdown()`, or being marked orphan by `recoverOrphaned`.
 *
 * `delete(id)` no longer touches subprocesses after ADR-001; it requires
 * the task to be terminal first and removes only the record.
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

/**
 * Why a task ended in `failure` status. Discriminated by `kind`; each
 * variant carries the minimum extra context useful to operators.
 * `message` is the human-readable summary the dashboard renders.
 *
 * Variants:
 *  - `exited`   — subprocess exited with a non-zero code; carries `exitCode`.
 *  - `signal`   — subprocess was terminated by an OS signal; carries `signal`.
 *  - `shutdown` — `TaskManager.shutdown()` killed the subprocess (server stop).
 *  - `orphan`   — `recoverOrphaned` marked a row whose owning process is gone.
 *  - `internal` — kernel-side fault (e.g. exit watcher rejected); covers
 *                 the legacy-row read path (rows written before this ADR
 *                 had only a free-string `failure_error` column — those
 *                 surface as `{ kind: 'internal', message }`).
 */
export type TaskFailure =
  | { readonly kind: "exited"; readonly exitCode: number; readonly message: string }
  | { readonly kind: "signal"; readonly signal: NodeJS.Signals; readonly message: string }
  | { readonly kind: "shutdown"; readonly message: string }
  | { readonly kind: "orphan"; readonly message: string }
  | { readonly kind: "internal"; readonly message: string };

/**
 * Why a task ended in `cancelled` status. Discriminated by `kind`.
 *
 * Variants:
 *  - `user`   — `TaskManager.cancel(id)` killed a live subprocess at the
 *               operator's request (today the only normal source).
 *  - `orphan` — `cancel(id)` was called on a `running` row that has no
 *               live entry (an undetected orphan that `recoverOrphaned`
 *               missed). The cancel routes through `applyTerminal` with
 *               this kind so the persisted row has the same shape as
 *               the normal path. The operator sees a one-line warning
 *               in the server log.
 *
 * Discriminator is `kind` (not `source`) to stay consistent with
 * {@link TaskFailure} and to fit future event-shaped variants
 * (`timeout`, `cascade`, `budget`) that aren't actors.
 */
export type TaskCancellation =
  | { readonly kind: "user"; readonly message: string }
  | { readonly kind: "orphan"; readonly message: string };

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
}

/** Inputs to `TaskManager.dispatch`. */
export interface DispatchOpts {
  /** Catalog name of the agent to run. Required. */
  readonly agent: string;
  /**
   * Short, single-line task title (≤ 200 chars by contract; the
   * server validates the wire shape). Doubles as the displayed label
   * everywhere — task list rows, detail panel header, CLI table.
   * Materialized as the `# <brief>` header in `<workdir>/TASK.md`.
   */
  readonly brief: string;
  /**
   * Optional long-form task body. When present, written as the
   * markdown body of `<workdir>/TASK.md` under the `# <brief>` header.
   * Multi-line allowed; `undefined`/empty produces a brief-only TASK.md.
   */
  readonly details?: string;
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
