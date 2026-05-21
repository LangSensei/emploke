/**
 * Domain types for @emploke/task.
 *
 * The `Task` entity itself lives in {@link ./task-entity.ts} (DDD class
 * with `static fromStored()` / `static create()` plus state-transition
 * methods `start` / `complete` / `fail` / `cancel` 鈥?mirrors the
 * `@emploke/catalog` Agent pattern). This file holds the supporting
 * value types: status enum, result / failure shapes, and `TaskService`
 * configuration. They're deliberately plain interfaces 鈥?they're
 * either exhaustive enums (`TaskStatus`), value-only payloads
 * (`TaskSuccess`, `TaskFailure`, `TaskCancellation`), or constructor-options bags
 * (`TaskServiceConfig`) where DDD adds no leverage.
 *
 * Why metadata instead of named fields on Task:
 *  - The Task type never has to change when a new runtime arrives.
 *  - SDK runtimes (no PID), serverless runtimes (no work dir), and
 *    classic CLI runtimes can all coexist.
 *  - Mirrors the kernel `Capability.Metadata` convention from the Go
 *    archive 鈥?emploke "stores but never reads" runtime metadata.
 */

import type { CatalogService } from "@emploke/catalog";
import type { RuntimeRegistry } from "@emploke/runtime";

/**
 * Status lifecycle: `running 鈫?succeeded | failed | cancelled` (issue #119).
 *
 * v4 normalized the enum to all-adjective form so the wire shape lines
 * up with `workflow_nodes.status` in #118. Tasks are created directly
 * in `running` (the historical `not_started` placeholder is gone 鈥?the
 * manager's exit watcher / cancel path is the only producer of a
 * terminal transition; nothing ever queued a `not_started` row to disk).
 *
 * `cancelled` is produced by `TaskService.cancel(id)` (the user-initiated
 * verb introduced in ADR-001). `failed` covers everything else the
 * subprocess might do 鈥?crashing, exiting non-zero, getting SIGTERM'd
 * by `shutdown()`, or being marked orphan by `recoverOrphaned`.
 *
 * `delete(id)` no longer touches subprocesses after ADR-001; it requires
 * the task to be terminal first and removes only the record.
 */
export type TaskStatus = "running" | "succeeded" | "failed" | "cancelled";

/** A status from which no further transitions are legal. */
export type TerminalStatus = "succeeded" | "failed" | "cancelled";

/**
 * Who launched this task. v4 first-class column (issue #119) 鈥?pre-
 * positioned for #118 (workflow-launched tasks) and future schedule /
 * agent-launched tasks. New dispatches default to `'standalone'` (a
 * direct CLI / dashboard / MCP call).
 *
 * String union (not enum) so future additions are additive 鈥?adding
 * `'schedule'` later does not break consumers that only branch on
 * existing values.
 */
export type TaskOrigin = "standalone" | "workflow";

/**
 * Payload attached when a Task transitions to `succeeded`.
 *
 * `output` semantics under the current **runtime-driven completion model**:
 * the kernel does not interpret what an autonomous agent produced. The
 * substantive output of an agent run lives on the filesystem under
 * `Task.metadata.workdir/` 鈥?agent-written files and the captured
 * `stderr.log`. The runtime's per-task event stream lives on the
 * runtime's own state directory (e.g.
 * `<copilotStateDir>/<runtimeSessionId>/events.jsonl`) and is read
 * via `Runtime.readActivity` rather than mirrored into the workdir.
 * The `output` string is intentionally minimal and may be empty:
 * today `TaskService` always writes `""` here.
 *
 * `deliverable` / `artifacts` are pre-positioned for issue #26
 * (agent-driven completion model). They're optional today so the wire
 * shape can extend without DDL 鈥?the JSON column inside which `success`
 * lives accepts arbitrary additional keys without a v5 bump.
 */
export interface TaskSuccess {
  readonly output: string;
  readonly deliverable?: unknown;
  readonly artifacts?: readonly string[];
}

/**
 * Why a task ended in `failure` status. Discriminated by `kind`; each
 * variant carries the minimum extra context useful to operators.
 * `message` is the human-readable summary the dashboard renders.
 *
 * Variants:
 *  - `exited`   鈥?subprocess exited with a non-zero code; carries `exitCode`.
 *  - `signal`   鈥?subprocess was terminated by an OS signal; carries `signal`.
 *  - `shutdown` 鈥?`TaskService.shutdown()` killed the subprocess (server stop).
 *  - `orphan`   鈥?`recoverOrphaned` marked a row whose owning process is gone.
 *  - `internal` 鈥?kernel-side fault (e.g. exit watcher rejected); covers
 *                 the legacy-row read path (rows written before this ADR
 *                 had only a free-string `failure_error` column 鈥?those
 *                 surface as `{ kind: 'internal', message }`).
 */
export type TaskFailure =
  | { readonly kind: "exited"; readonly exit_code: number; readonly message: string }
  | { readonly kind: "signal"; readonly signal: NodeJS.Signals; readonly message: string }
  | { readonly kind: "shutdown"; readonly message: string }
  | { readonly kind: "orphan"; readonly message: string }
  | { readonly kind: "internal"; readonly message: string };

/**
 * Why a task ended in `cancelled` status. Discriminated by `kind`.
 *
 * Variants:
 *  - `user`    鈥?`TaskService.cancel(id)` killed a live subprocess at
 *                the operator's request (today the only normal source).
 *  - `cascade` 鈥?cancelled as a side-effect of another manager-side
 *                event (e.g. orphan-row reconciliation, future parent-
 *                workflow cancellation). Pre-v4 the orphan-recovery
 *                path produced `{ kind: 'orphan' }`; folded into
 *                `cascade` in #119 since the distinction was never
 *                consumed by callers.
 *
 * Discriminator is `kind` (not `source`) to stay consistent with
 * {@link TaskFailure} and to fit future event-shaped variants
 * (`timeout`, `budget`) that aren't actors.
 */
export type TaskCancellation =
  | { readonly kind: "user"; readonly message: string }
  | { readonly kind: "cascade"; readonly message: string };

/**
 * Wire-shape DTO for a task. Matches the JSON produced by
 * `TaskEntity.toJSON()`. This is what `TaskService` returns to
 * external callers and what the HTTP layer serialises.
 *
 * The class with state-transition methods lives in `task-entity.ts`
 * as `TaskEntity` and is internal to the package.
 */
export interface Task {
  readonly id: string;
  readonly agent: string;
  readonly brief: string;
  readonly details?: string;
  readonly origin: TaskOrigin;
  readonly status: TaskStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly success?: TaskSuccess;
  readonly failure?: TaskFailure;
  readonly cancellation?: TaskCancellation;
}

// 鈹€鈹€鈹€ TaskService-side types 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import type * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/** Constructor options for `TaskService`. */
export interface TaskServiceConfig {
  readonly catalog: CatalogService;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly workspaceDir: string;
  readonly workspaceId: string;
  /**
   * Drizzle (better-sqlite3) database handle backing the `tasks` table.
   */
  readonly db: Db;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly randomBytes?: (n: number) => Buffer;
}

/** Inputs to `TaskService.dispatch`. */
export interface DispatchOpts {
  /** Catalog name of the agent to run. Required. */
  readonly agent: string;
  /**
   * Short, single-line task title (鈮?200 chars by contract; the
   * server validates the wire shape). Doubles as the displayed label
   * everywhere 鈥?task list rows, detail panel header, CLI table.
   * Materialized as the `# <brief>` header in `<workdir>/TASK.md`.
   */
  readonly brief: string;
  /**
   * Optional long-form task body. When present, written as the
   * markdown body of `<workdir>/TASK.md` under the `# <brief>` header.
   * Multi-line allowed; `undefined`/empty produces a brief-only TASK.md.
   */
  readonly details?: string;
  /** Runtime kind. Defaults to `"copilot"`. */
  readonly runtime?: string;
  /**
   * Who launched this task. Defaults to `'standalone'` in the manager
   * when omitted (a direct CLI / dashboard / MCP call). Workflow /
   * future scheduler call sites pass `'workflow'` so dashboards and
   * CLI can filter standalone-only by default and reveal workflow-
   * launched tasks on demand.
   */
  readonly origin?: TaskOrigin;
}

/**
 * Options for `TaskService.list`. Mirrors the shape of
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
  /**
   * Filter to tasks whose `origin` matches the given value, or any
   * value in the given array. Accepts a single {@link TaskOrigin} or
   * a readonly array; omit to disable the filter and return tasks of
   * every origin.
   */
  readonly origin?: TaskOrigin | readonly TaskOrigin[];
}
