/**
 * Domain types for @emploke/task.
 *
 * The `Task` entity itself lives in {@link ./task-entity.ts} (DDD class
 * with `static fromStored()` / `static create()` plus state-transition
 * methods `start` / `complete` / `fail` / `cancel` — mirrors the
 * `@emploke/catalog` Agent pattern). This file holds the supporting
 * value types: status enum, result / failure shapes, and `TaskService`
 * configuration. They're deliberately plain interfaces — they're
 * either exhaustive enums (`TaskStatus`), value-only payloads
 * (`TaskSuccess`, `TaskFailure`, `TaskCancellation`), or constructor-options bags
 * (`TaskServiceConfig`) where DDD adds no leverage.
 *
 * Why metadata instead of named fields on Task:
 *  - The Task type never has to change when a new runtime arrives.
 *  - SDK runtimes (no PID), serverless runtimes (no work dir), and
 *    classic CLI runtimes can all coexist.
 *  - Mirrors the kernel `Capability.Metadata` convention from the Go
 *    archive — emploke "stores but never reads" runtime metadata.
 */

import type { AgentContentSource, RuntimeRegistry } from "@emploke/runtime";
import type { AgentResolverPort } from "./ports.js";

/**
 * Status lifecycle: `running → succeeded | failed | cancelled`.
 *
 * The enum is all-adjective so the wire shape lines up with the
 * workflow node status column. Tasks are created directly in
 * `running` — there is no intermediate state between dispatch and
 * the subprocess actually starting; the manager's exit watcher /
 * cancel path is the only producer of a terminal transition.
 *
 * `cancelled` is produced by `TaskService.cancel(id)` — the only
 * user-initiated verb that ends a task. `failed` covers everything
 * else the subprocess might do — crashing, exiting non-zero, getting
 * SIGTERM'd by `shutdown()`, or being marked orphan by
 * `recoverOrphaned`.
 *
 * `delete(id)` never touches subprocesses; it requires the task to
 * be terminal first and removes only the record.
 */
export type TaskStatus = "running" | "succeeded" | "failed" | "cancelled";

/** A status from which no further transitions are legal. */
export type TerminalStatus = "succeeded" | "failed" | "cancelled";

/**
 * Runtime list of every {@link TerminalStatus}. Kept in lock-step with the
 * {@link TerminalStatus} type via the `satisfies` clause — adding a new
 * status to the type without updating this list (or vice versa) is a
 * type error.
 *
 * The repository / service layers use this to express "task is *not*
 * terminal" without hard-coding the status name `"running"`. That keeps
 * forward compatibility when a future non-terminal status (e.g.
 * `"queued"`) is added: it will automatically be treated as in-flight by
 * `hasInFlightForSchedule` and skipped by `deleteTerminalForSchedule`.
 */
export const TERMINAL_TASK_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly TerminalStatus[];

/**
 * Who launched this task. A first-class column on the row, pre-
 * positioned for workflow- and schedule-launched tasks. New
 * dispatches default to `'standalone'` (a direct CLI / dashboard /
 * MCP call).
 *
 * String union (not enum) so future additions are additive — adding
 * a new origin later does not break consumers that only branch on
 * existing values.
 */
export type TaskOrigin = "standalone" | "workflow" | "schedule";

/**
 * Payload attached when a Task transitions to `succeeded`. Both fields
 * are populated at terminal time by `TaskService.applyTerminal` and
 * are persisted verbatim into the `success` JSON column — they are
 * never re-derived on read.
 */
export interface TaskSuccess {
  /**
   * Head of the agent's last assistant utterance, capped to
   * `TASK_OUTPUT_MAX_CHARS` chars. `null` when the agent finished
   * without producing an assistant turn (rare) or when the runtime's
   * structured activity surface was unavailable at terminal time.
   * Persisted; never re-derived on read. Treat `null` semantically as
   * "no summary available" — distinct from `""` which would mean "the
   * agent explicitly produced an empty turn".
   */
  readonly output: string | null;
  /**
   * Absolute paths of files found under `<workdir>/artifact/` at
   * terminal time. Populated by `applyTerminal`. Empty array (or
   * absent on legacy rows) if the agent wrote no artifacts. Order is
   * lexicographic by basename for determinism. Persisted; never
   * re-derived on read.
   */
  readonly artifacts?: readonly string[];
}

/**
 * Why a task ended in `failure` status. Discriminated by `kind`; each
 * variant carries the minimum extra context useful to operators.
 * `message` is the human-readable summary the dashboard renders.
 *
 * Variants:
 *  - `exited`   — subprocess exited with a non-zero code; carries `exitCode`.
 *  - `signal`   — subprocess was terminated by an OS signal; carries `signal`.
 *  - `shutdown` — `TaskService.shutdown()` killed the subprocess (server stop).
 *  - `orphan`   — `recoverOrphaned` marked a row whose owning process is gone.
 *  - `internal` — kernel-side fault (e.g. exit watcher rejected); covers
 *                 the legacy-row read path (rows written before typed
 *                 failure payloads had only a free-string `failure_error`
 *                 column — those surface as `{ kind: 'internal', message }`).
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
 *  - `user`    — `TaskService.cancel(id)` killed a live subprocess at
 *                the operator's request (today the only normal source).
 *  - `cascade` — cancelled as a side-effect of another manager-side
 *                event (e.g. orphan-row reconciliation, future parent-
 *                workflow cancellation). The orphan-recovery path
 *                produces `cascade` rather than a distinct orphan
 *                kind, because no caller branches on the orphan
 *                flavour specifically.
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

// ─── TaskService-side types ───────────────────────────────────

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Logger } from "pino";
import type * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/** Constructor options for `TaskService`. */
export interface TaskServiceConfig {
  readonly agentResolver: AgentResolverPort;
  readonly contentSource: AgentContentSource;
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
  /** Runtime kind. Defaults to `"copilot"`. */
  readonly runtime?: string;
  /**
   * Who launched this task. Defaults to `'standalone'` in the manager
   * when omitted (a direct CLI / dashboard / MCP call). Workflow /
   * scheduler call sites pass `'workflow'` / `'schedule'` so dashboards
   * and CLI can filter standalone-only by default and reveal workflow-
   * or schedule-launched tasks on demand.
   */
  readonly origin?: TaskOrigin;
  /**
   * Optional caller-supplied metadata to shallow-merge into the initial
   * Task.metadata bag. Kernel-supplied keys (workdir, runtime) take
   * precedence — user values for those keys are silently overridden.
   * Used by the scheduler to inject {scheduleId, firedAt}; future
   * orchestrators can add their own tags.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Optional caller-supplied env bag merged on top of the 5 kernel
   * env keys (`EMPLOKE_WORKSPACE`, `EMPLOKE_WORKSPACE_DIR`,
   * `EMPLOKE_WORK_KIND`, `EMPLOKE_WORK_ID`, `EMPLOKE_WORK_DIR`) that
   * dispatch always sets on the spawned subprocess.
   *
   * Boundary check: dispatch throws {@link DispatchKernelEnvCollisionError}
   * if any caller key collides with a kernel key. Callers must use
   * namespaced keys (e.g. `EMPLOKE_WORKFLOW_ID`, `EMPLOKE_NODE_ID`).
   *
   * The runtime layer's own cross-cutting env (`EMPLOKE_SERVER`,
   * `EMPLOKE_SHARED_DIR`, …) layers underneath via the runtime's
   * `subprocessEnvBase` config; this bag does not interact with it.
   *
   * Domain-clean: the task pkg does not interpret these keys.
   * Workflow / scheduler / future orchestrators are the domain-aware
   * layer that knows what each key means.
   */
  readonly subprocessEnv?: Readonly<Record<string, string>>;
  /**
   * Optional override for the framing prompt the runtime receives as
   * the spawn-time `prompt` argv. Defaults to
   * {@link TASK_FRAMING_PROMPT_COPILOT} ("read TASK.md, save artifacts
   * to ./artifact/, prefer self-contained HTML"). The
   * {@link assertFramingPromptIsSafe} invariant runs on whichever
   * prompt is actually used (default OR override) so any unsafe
   * override (multi-line, non-printable-ASCII) throws pre-spawn.
   *
   * Used by callers (e.g. the workflow coordinator runner) that need
   * a kind-specific framing the substrate can't infer.
   */
  readonly prompt?: string;
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
  /**
   * Filter to tasks whose `metadata.scheduleId` matches the given value.
   * Combined with the other filters via AND. Useful for the schedule
   * detail page's "recent fires" panel.
   */
  readonly scheduleId?: string;
}
