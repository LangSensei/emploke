import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentResolveResult, Catalog } from "@emploke/catalog";
import type { RuntimeRegistry, TaskHandle } from "@emploke/runtime";
import { apply } from "./apply.js";
import { create as createTask } from "./create.js";
import {
  AgentNotFoundError,
  RuntimeDoesNotSupportTasksError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
} from "./errors.js";
import { assertValidTaskId, generateTaskId, TASK_ID_RE } from "./ids.js";
import { createDirJunction } from "./junction.js";
import { safeJoinUnderRoot } from "./paths.js";
import {
  CURRENT_SCHEMA_VERSION,
  type PersistedTask,
  readPersistedTask,
  writePersistedTask,
} from "./task-file.js";
import type { DispatchOpts, Logger, Task, TaskManagerConfig } from "./types.js";

const SILENT_LOGGER: Logger = { warn: () => {} };
const DEFAULT_RUNTIME = "copilot";
const MAX_CREATE_RETRIES = 5;

/** Subdirectory name under each task workdir that points (via junction) at the runtime's per-task log dir. */
const SESSION_LINK = "session";

/**
 * In-memory record for a task whose subprocess we still own. Once the
 * subprocess exits and the post-exit fs writes complete, the entry is
 * dropped from the map.
 */
interface LiveTask {
  readonly id: string;
  readonly handle: TaskHandle;
  /** Resolves once the post-exit persistence has finished (success or failure path). */
  readonly settled: Promise<void>;
}

/**
 * Per-workspace registry of autonomous tasks.
 *
 * Owns `<tasksDir>/` on disk. Each task is one directory containing the
 * persisted `task.json`, a `session/` junction into the runtime's native
 * log directory, an `stderr.log` capture, and whatever the agent itself
 * wrote during execution.
 *
 * The manager is the source of truth for task state. It:
 *
 *   - reserves a fresh id and workdir per dispatch
 *   - asks the runtime to spawn the subprocess and hands ownership off
 *   - watches the subprocess for exit and persists the terminal status
 *   - on shutdown, kills any live subprocess and marks it `failure`
 *   - on bootstrap, marks orphaned `running` tasks (server crashed
 *     mid-flight) as `failure` so they don't appear hanging forever
 *
 * The Task value type itself is the FSM; this class just orchestrates
 * persistence + side effects around it.
 */
export class TaskManager {
  private readonly catalog: Catalog;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly defaultRuntime: string;
  private readonly tasksDir: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;

  /** id → live record for tasks whose subprocess this manager still owns. */
  private readonly live = new Map<string, LiveTask>();

  /** True once `shutdown()` has been called; gates exit-watcher's status decision. */
  private shuttingDown = false;

  constructor(config: TaskManagerConfig) {
    this.catalog = config.catalog;
    this.runtimeRegistry = config.runtimeRegistry;
    this.defaultRuntime = config.defaultRuntime ?? DEFAULT_RUNTIME;
    this.tasksDir = path.resolve(config.tasksDir);
    this.logger = config.logger ?? SILENT_LOGGER;
    this.now = config.now ?? (() => new Date());
    this.randomBytes = config.randomBytes ?? defaultRandomBytes;
  }

  // ─── dispatch ────────────────────────────────────────────

  async dispatch(opts: DispatchOpts): Promise<Task> {
    if (this.shuttingDown) {
      // Refuse new work once shutdown has been called. Avoids a race where
      // a request is mid-flight when the SIGTERM lands and we end up
      // spawning a subprocess we have to immediately kill.
      throw new Error("task manager is shutting down; refusing new dispatches");
    }

    // 1. Resolve agent. Bare-Error throws from the resolver are rewrapped
    //    so callers can `instanceof AgentNotFoundError` without losing the
    //    original cause.
    const agentName = opts.agent;
    if (typeof agentName !== "string" || agentName.length === 0) {
      throw new AgentNotFoundError(String(agentName));
    }
    let resolveResult: AgentResolveResult;
    try {
      resolveResult = this.catalog.resolveAgent(agentName);
    } catch (err) {
      throw new AgentNotFoundError(agentName, err as Error);
    }

    // 2. Pick the runtime + verify it supports tasks. We do this before
    //    reserving the workdir so a misconfiguration doesn't litter empty
    //    dirs on disk.
    const runtimeKind = opts.runtime ?? this.defaultRuntime;
    const runtime = this.runtimeRegistry.get(runtimeKind);
    if (typeof runtime.dispatchTask !== "function") {
      throw new RuntimeDoesNotSupportTasksError(runtime.kind);
    }

    // 3. Reserve a workdir via exclusive mkdir, retrying on EEXIST.
    await mkdir(this.tasksDir, { recursive: true });
    let id: string | null = null;
    let workdir: string | null = null;
    for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
      const candidateId = generateTaskId(this.now, this.randomBytes);
      const candidateDir = safeJoinUnderRoot(this.tasksDir, candidateId);
      try {
        await mkdir(candidateDir, { recursive: false });
        id = candidateId;
        workdir = candidateDir;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        throw err;
      }
    }
    if (id === null || workdir === null) {
      throw new TaskIdAllocationFailedError(MAX_CREATE_RETRIES);
    }

    // 4. Persist the initial Task in `not_started`. If anything below
    //    fails, we rollback the workdir entirely — pre-spawn failures
    //    should not leave a ghost failure-status task on disk (per the
    //    Task FSM, `fail` is only legal from `running`, so we'd have to
    //    persist a status the kernel doesn't permit anyway).
    const createdAt = this.now().toISOString();
    let initial = createTask({
      id,
      agent: agentName,
      instructions: opts.instructions,
      createdAt,
      metadata: {
        workdir,
        runtime: runtime.kind,
      },
    });
    try {
      await this.persist(workdir, initial);
    } catch (err) {
      await safeRm(workdir, this.logger);
      throw err;
    }

    // 5. Spawn. The runtime owns the subprocess and gives us back a
    //    handle. Failures here (provision throws, spawn ENOENT, ...) are
    //    pre-running, so we rollback the workdir and rethrow.
    let handle: TaskHandle;
    try {
      handle = await runtime.dispatchTask({
        taskDir: workdir,
        agent: resolveResult,
        prompt: opts.instructions,
      });
    } catch (err) {
      await safeRm(workdir, this.logger);
      throw err;
    }

    // 6. Apply `start` and persist the running record. From this point
    //    on, terminal status comes from the exit watcher; a write failure
    //    here would leave us inconsistent (subprocess up, disk says
    //    not_started), so we do NOT roll back — we surface the error to
    //    the caller with the subprocess still live and the dir still
    //    on disk. The orphan recovery path will mark it failed at the
    //    next bootstrap if the server then restarts. In practice this
    //    write is local fs to a dir we just created, so it does not fail.
    const startMetaPatch: Record<string, unknown> = {
      pid: handle.pid,
    };
    if (handle.runtimeSessionId !== undefined) {
      startMetaPatch.runtimeSessionId = handle.runtimeSessionId;
    }
    const running = apply(
      initial,
      { type: "start", metadata: startMetaPatch },
      this.now().toISOString(),
    );
    initial = running; // refresh local view for any future use
    await this.persist(workdir, running);

    // 7. Wire post-spawn background work: junction the runtime's session
    //    dir under `<workdir>/session/`, then watch for exit and persist
    //    the terminal status. Both run independently — junction failure
    //    must not block exit handling. We expose a `settled` promise so
    //    `shutdown()` and tests can await drain.
    const settled = (async () => {
      // 7a. Junction the runtime's session dir. Best-effort: if the
      //     runtime can't tell us where it lives, or symlink fails (e.g.
      //     Windows without the right perms), we log and move on. The
      //     dashboard's events tab will 404 on `events.jsonl`, which is
      //     a recoverable degradation.
      this.installSessionJunction(workdir, handle).catch((err) => {
        this.logger.warn("tasks: failed to install session junction", {
          taskId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // 7b. Wait for exit + apply terminal status.
      let exitInfo: Awaited<TaskHandle["exit"]>;
      try {
        exitInfo = await handle.exit;
      } catch (err) {
        // Should not happen — handle.exit is built from child events that
        // resolve, never reject. Treat as unknown failure.
        await this.applyTerminal(workdir, running, {
          ok: false,
          reason: `exit watcher rejected: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: null,
          exitSignal: null,
        });
        this.live.delete(id);
        return;
      }

      const decision = decideTerminal(exitInfo, this.shuttingDown);
      await this.applyTerminal(workdir, running, decision);
      this.live.delete(id);
    })();

    this.live.set(id, { id, handle, settled });

    return running;
  }

  // ─── list ────────────────────────────────────────────────

  /**
   * List every persisted task in `tasksDir`, newest first. Cheap reads
   * only — no runtime introspection. Corrupted entries are logged and
   * skipped.
   */
  async list(): Promise<Task[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.tasksDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const drafts = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && TASK_ID_RE.test(e.name))
        .map(async (e) => {
          const id = e.name;
          const workdir = safeJoinUnderRoot(this.tasksDir, id);
          return this.loadTask(id, workdir);
        }),
    );

    const tasks: Task[] = [];
    for (const t of drafts) {
      if (t !== null) tasks.push(t);
    }

    // Newest first. createdAt is ISO 8601 → lexicographic sort. Id is the
    // deterministic tiebreaker for tasks created in the same millisecond.
    tasks.sort((a, b) => {
      const d = b.createdAt.localeCompare(a.createdAt);
      return d !== 0 ? d : b.id.localeCompare(a.id);
    });
    return tasks;
  }

  // ─── get ─────────────────────────────────────────────────

  async get(id: string): Promise<Task | null> {
    assertValidTaskId(id);
    const workdir = safeJoinUnderRoot(this.tasksDir, id);
    return this.loadTask(id, workdir);
  }

  // ─── delete ──────────────────────────────────────────────

  /**
   * Remove a task: kill the subprocess if it's still live, then rm -rf
   * the workdir. Throws `TaskNotFoundError` if no such task exists.
   *
   * Note: deleting a live task does NOT mark it `cancelled` first — the
   * caller asked for it to vanish, not for an audit trail. Live workers
   * receive a kill signal and the workdir is destroyed.
   */
  async delete(id: string): Promise<void> {
    assertValidTaskId(id);
    const workdir = safeJoinUnderRoot(this.tasksDir, id);
    const existing = await this.loadTask(id, workdir);
    if (existing === null) {
      throw new TaskNotFoundError(id);
    }

    const live = this.live.get(id);
    if (live !== undefined) {
      // Drop from live first so the exit watcher's `this.live.delete(id)`
      // is a no-op and doesn't race with our rm. Then kill + await drain
      // so we don't `rm -rf` a dir while the subprocess is still writing
      // into it.
      this.live.delete(id);
      try {
        live.handle.kill();
      } catch {
        // Already dead. Continue.
      }
      try {
        await live.handle.exit;
      } catch {
        // Same as above — handle.exit shouldn't reject, but defensive.
      }
      // We intentionally don't apply a terminal event here; the workdir
      // is about to be removed.
    }

    await rm(workdir, { recursive: true, force: true });
  }

  // ─── recoverOrphaned ─────────────────────────────────────

  /**
   * Sweep `tasksDir` and mark any persisted task whose status is still
   * `running` as `failure`. Called once at server bootstrap so a task
   * whose owner-process crashed (or was kill -9'd) doesn't show up as
   * forever-running in the dashboard.
   */
  async recoverOrphaned(): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.tasksDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && TASK_ID_RE.test(e.name))
        .map(async (e) => {
          const id = e.name;
          const workdir = safeJoinUnderRoot(this.tasksDir, id);
          const task = await this.loadTask(id, workdir);
          if (task === null) return;
          if (task.status !== "running") return;
          try {
            const failed = apply(
              task,
              {
                type: "fail",
                error: "orphaned (server crashed before this task ended)",
              },
              this.now().toISOString(),
            );
            await this.persist(workdir, failed);
          } catch (err) {
            this.logger.warn("tasks: failed to mark orphaned task as failure", {
              taskId: id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
    );
  }

  // ─── shutdown ────────────────────────────────────────────

  /**
   * Kill every live subprocess, await their exit + post-exit persistence,
   * and stop accepting new dispatches. Idempotent — calling twice is a
   * no-op the second time.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      // Wait for the in-flight shutdown's drain to complete by awaiting
      // current settled promises. New dispatches are already blocked.
      await Promise.allSettled([...this.live.values()].map((l) => l.settled));
      return;
    }
    this.shuttingDown = true;

    const snapshot = [...this.live.values()];
    for (const l of snapshot) {
      try {
        l.handle.kill();
      } catch {
        // Already dead — let the exit watcher run its course.
      }
    }
    // Wait for every exit watcher to finish persisting its terminal
    // status. The exit watcher checks `this.shuttingDown` to decide
    // between "server shutdown" and the natural exit reason.
    await Promise.allSettled(snapshot.map((l) => l.settled));
  }

  // ─── internals ───────────────────────────────────────────

  /** Read + validate the persisted task at `workdir`, or null on miss. */
  private async loadTask(id: string, workdir: string): Promise<Task | null> {
    const res = await readPersistedTask(workdir);
    if (res === null) {
      return null;
    }
    if (res.ok === false) {
      this.logger.warn("tasks: skipping corrupted task.json", {
        taskId: id,
        reason: res.reason,
      });
      return null;
    }
    if (res.value.task.id !== id) {
      // Defensive: directory name and id-in-file disagree. Trust the
      // directory name (it's how we found this) and surface a warning.
      this.logger.warn("tasks: id mismatch between dir and task.json", {
        taskId: id,
        persistedId: res.value.task.id,
      });
    }
    return res.value.task;
  }

  /** Atomic write of the persisted record. */
  private async persist(workdir: string, task: Task): Promise<void> {
    const value: PersistedTask = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      task,
    };
    await writePersistedTask(workdir, value);
  }

  /**
   * Wait for `handle.sessionDir` and create a junction at
   * `<workdir>/session/`. If the link already exists (re-run, recovery),
   * leave it alone. Throws on hard failures so the caller can log.
   */
  private async installSessionJunction(workdir: string, handle: TaskHandle): Promise<void> {
    const target = await handle.sessionDir;
    const link = path.join(workdir, SESSION_LINK);
    try {
      await stat(link);
      // Already exists — assume it's correct (same target). Don't replace.
      return;
    } catch {
      // ENOENT — create it below.
    }
    await createDirJunction(target, link);
  }

  /** Apply the terminal event to a running task and persist. */
  private async applyTerminal(
    workdir: string,
    running: Task,
    decision: TerminalDecision,
  ): Promise<void> {
    const metaPatch: Record<string, unknown> = {
      exitCode: decision.exitCode,
      exitSignal: decision.exitSignal,
    };
    let next: Task;
    try {
      if (decision.ok) {
        next = apply(
          running,
          { type: "complete", output: "", metadata: metaPatch },
          this.now().toISOString(),
        );
      } else {
        next = apply(
          running,
          { type: "fail", error: decision.reason, metadata: metaPatch },
          this.now().toISOString(),
        );
      }
      await this.persist(workdir, next);
    } catch (err) {
      this.logger.warn("tasks: failed to persist terminal status", {
        taskId: running.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─── module-private helpers ────────────────────────────────

interface TerminalDecision {
  readonly ok: boolean;
  readonly reason: string; // empty when ok
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
}

/**
 * Translate a subprocess exit into a Task FSM transition.
 *
 *   - shutting down → failure, "server shutdown" (regardless of code/signal,
 *     because we asked for it)
 *   - exit code 0   → success
 *   - exit code N   → failure, "exited with code N"
 *   - signal X      → failure, "terminated by signal X"
 */
function decideTerminal(
  exitInfo: { code: number | null; signal: NodeJS.Signals | null },
  shuttingDown: boolean,
): TerminalDecision {
  if (shuttingDown) {
    return {
      ok: false,
      reason: "server shutdown",
      exitCode: exitInfo.code,
      exitSignal: exitInfo.signal,
    };
  }
  if (exitInfo.code === 0) {
    return {
      ok: true,
      reason: "",
      exitCode: 0,
      exitSignal: exitInfo.signal,
    };
  }
  if (exitInfo.signal !== null) {
    return {
      ok: false,
      reason: `terminated by signal ${exitInfo.signal}`,
      exitCode: exitInfo.code,
      exitSignal: exitInfo.signal,
    };
  }
  return {
    ok: false,
    reason: `exited with code ${exitInfo.code}`,
    exitCode: exitInfo.code,
    exitSignal: exitInfo.signal,
  };
}

/** Best-effort recursive remove. Logs (does not throw) on failure. */
async function safeRm(p: string, logger: Logger): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true });
  } catch (err) {
    logger.warn("tasks: failed to remove workdir during cleanup", {
      path: p,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function defaultRandomBytes(n: number): Buffer {
  return cryptoRandomBytes(n);
}

export type { TaskRuntimeMetadata } from "./task-file.js";
// Re-export typed metadata reader so consumers don't have to dig into
// `task-file.js`.
export { readTaskRuntimeMetadata } from "./task-file.js";
