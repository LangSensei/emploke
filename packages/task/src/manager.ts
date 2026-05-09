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
  readTaskRuntimeMetadata,
  writePersistedTask,
} from "./task-file.js";
import type {
  DispatchOpts,
  ListTaskOpts,
  Logger,
  Task,
  TaskManagerConfig,
  TaskStatus,
} from "./types.js";

const SILENT_LOGGER: Logger = { warn: () => {} };
const DEFAULT_RUNTIME = "copilot";
const MAX_CREATE_RETRIES = 5;

/**
 * Subdirectory under each task workdir that links to the runtime's per-task
 * state directory.
 *
 * Naming note: kept as the singular `session` rather than the more literal
 * `runtime-state` (or the plural `sessions`, which would collide visually
 * with the workspace's `<workspace>/sessions/` directory holding interactive
 * Session workdirs). The link points at what each Runtime impl already calls
 * a "session" internally — the CLI's per-id unit of state, exposed as
 * `Session.runtimeSessionId` and Copilot's `<copilotStateDir>/<id>/`. Mirroring
 * that vocabulary keeps cross-file reading natural; the singular vs plural
 * disambiguates from the workspace's interactive-session directory.
 *
 * If we ever introduce a second runtime whose native term is not "session",
 * revisit and consider renaming to a runtime-neutral noun (e.g. `runtime-state`).
 */
const SESSION_LINK = "session";

/**
 * In-memory record for a task whose subprocess we still own. Once the
 * subprocess exits and the post-exit fs writes complete, the entry is
 * dropped from the map.
 *
 * `killedByUs` is the mutable flag that distinguishes "we (manager)
 * intentionally terminated this subprocess" (via `delete()` or
 * `shutdown()`) from "the subprocess exited on its own". It is checked
 * by the exit watcher when classifying the terminal state — without
 * it, a process that exits cleanly (`code: 0`) at the same instant as
 * `shutdown()` runs would race against the global flag and be
 * mis-recorded as `failure: "server shutdown"` rather than `success`.
 * Per-task scope ensures one task's shutdown override doesn't bleed
 * into another's natural exit.
 */
interface LiveTask {
  readonly id: string;
  readonly handle: TaskHandle;
  /** Resolves once the post-exit persistence has finished (success or failure path). */
  readonly settled: Promise<void>;
  /**
   * Set to true when `delete()` or `shutdown()` calls `handle.kill()`
   * for this task. The exit watcher reads this AT exit time (not at the
   * moment shutdown began) so a clean self-exit racing with shutdown is
   * still classified as `success`, not `failure: "server shutdown"`.
   */
  killedByUs: boolean;
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
    const initial = createTask({
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

    // 5b. Re-check `shuttingDown` after spawn. The flag is read once at
    //     the top of `dispatch()`, but `await runtime.dispatchTask(...)`
    //     yields the event loop and a SIGTERM-driven `shutdown()` could
    //     have flipped it during that window. Without this guard the
    //     subprocess is now live but `shutdown()`'s snapshot of
    //     `this.live` (taken before we get to the `live.set` below)
    //     would not include it — the manager would return cleanly, the
    //     server would call `process.exit(0)`, and the subprocess would
    //     be left as an orphan that the next boot's `recoverOrphaned()`
    //     marks as failure.
    if (this.shuttingDown) {
      try {
        handle.kill();
      } catch {
        // Already dead.
      }
      try {
        await handle.exit;
      } catch {
        // exit promise should never reject by construction.
      }
      await safeRm(workdir, this.logger);
      throw new Error("task manager is shutting down; refusing new dispatches");
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
    await this.persist(workdir, running);

    // 7. Wire post-spawn background work: junction the runtime's session
    //    dir under `<workdir>/session/`, then watch for exit and persist
    //    the terminal status. Both run independently — junction failure
    //    must not block exit handling. We expose a `settled` promise so
    //    `shutdown()` and tests can await drain.
    //
    //    Order matters: we register the `LiveTask` entry BEFORE awaiting
    //    anything, so a `shutdown()` arriving between this register and
    //    the watcher's first `await` will see the entry in `this.live`
    //    and route through the kill+drain path rather than missing it.
    //    The watcher's IIFE closes over `liveEntry` so it can read
    //    `liveEntry.killedByUs` AT exit time (not at watcher-start
    //    time) — the value is what `delete()` / `shutdown()` set when
    //    they invoked `kill()`, so a clean self-exit racing with
    //    shutdown still classifies as `success`.
    const liveEntry: LiveTask = {
      id,
      handle,
      killedByUs: false,
      // `settled` is filled in just below; we need the object reference
      // first so the IIFE can close over it.
      settled: undefined as unknown as Promise<void>,
    };
    const settled = (async () => {
      // 7a. Junction the runtime's session dir. Best-effort: if the
      //     runtime can't tell us where it lives, or symlink fails (e.g.
      //     Windows without the right perms), we log and move on. The
      //     dashboard's events tab will 404 NoEventsYet, which is a
      //     recoverable degradation (the runtime's event log path
      //     resolves through `Runtime.taskEventsPath`; with no junction
      //     installed that path doesn't exist on disk yet).
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

      // Read killedByUs AT exit time, per the LiveTask JSDoc. If the
      // task self-exited cleanly with `code: 0` while `shutdown()` was
      // running but had not yet invoked `kill()` for this task, this
      // flag is still false and we record `success`.
      const decision = decideTerminal(exitInfo, liveEntry.killedByUs);
      await this.applyTerminal(workdir, running, decision);
      this.live.delete(id);
    })();
    (liveEntry as { settled: Promise<void> }).settled = settled;

    this.live.set(id, liveEntry);

    return running;
  }

  // ─── list ────────────────────────────────────────────────

  /**
   * List persisted tasks in `tasksDir`, newest first. Cheap reads only —
   * no runtime introspection. Corrupted entries are logged and skipped.
   *
   * Filters in `opts` are applied server-side after reading each
   * `task.json`, so the manager returns only the rows the caller asked
   * for. This mirrors `@emploke/session`'s `list(ListSessionOpts)`
   * pattern and lets the dashboard push its filter UI down to the
   * server (so e.g. an "agent: writer" filter doesn't ship the other
   * 95% of the workspace's tasks across the wire on every poll).
   */
  async list(opts: ListTaskOpts = {}): Promise<Task[]> {
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

    const statusSet = opts.statuses ? new Set<TaskStatus>(opts.statuses) : null;
    const tasks: Task[] = [];
    for (const t of drafts) {
      if (t === null) continue;
      if (opts.agent !== undefined && t.agent !== opts.agent) continue;
      // ISO 8601 strings (Z-suffixed) sort lexicographically as dates.
      if (opts.createdSince !== undefined && t.createdAt < opts.createdSince) continue;
      if (opts.runtime !== undefined) {
        const runtimeMeta = readTaskRuntimeMetadata(t).runtime;
        if (runtimeMeta !== opts.runtime) continue;
      }
      if (statusSet !== null && !statusSet.has(t.status)) continue;
      tasks.push(t);
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

  // ─── getTaskEventsPath ───────────────────────────────────

  /**
   * Resolve the absolute path to the runtime-native event log for a
   * task, or `null` if no log is available (task missing, runtime
   * doesn't implement the optional surface, or runtime returned `null`
   * to signal "not yet").
   *
   * This is a thin facade over `Runtime.taskEventsPath`: it locates the
   * task, looks up the runtime by `metadata.runtime`, and forwards the
   * task's workdir. The route layer can then `stat` + stream the file
   * without depending on `@emploke/runtime` directly.
   *
   * Note: this method does not check whether the file exists on disk;
   * the runtime path may resolve to a file the agent hasn't written yet.
   * Callers that want a 404-vs-200 distinction should `stat` the
   * returned path themselves.
   */
  async getTaskEventsPath(id: string): Promise<string | null> {
    const task = await this.get(id);
    if (task === null) return null;
    const meta = readTaskRuntimeMetadata(task);
    if (typeof meta.workdir !== "string" || typeof meta.runtime !== "string") {
      return null;
    }
    let runtime: import("@emploke/runtime").Runtime;
    try {
      runtime = this.runtimeRegistry.get(meta.runtime);
    } catch {
      // The recorded runtime is no longer registered. Treat as "no
      // events available" rather than surfacing a 5xx — the dashboard
      // will render NoEventsYet, which is the right UX for an
      // unrecoverable task.
      return null;
    }
    if (typeof runtime.taskEventsPath !== "function") return null;
    try {
      return runtime.taskEventsPath(meta.workdir);
    } catch {
      // Runtime impls are not contractually required to be infallible
      // here — a buggy or partially-installed runtime could throw. Treat
      // it the same as the other "no events available" branches so the
      // route surfaces 404 NoEventsYet instead of 500. The dashboard
      // already renders that as a recoverable degradation.
      return null;
    }
  }

  // ─── delete ──────────────────────────────────────────────

  /**
   * Remove a task: kill the subprocess if it's still live, then rm -rf
   * the workdir. Throws `TaskNotFoundError` if no such task exists.
   *
   * Note: deleting a live task does NOT mark it `cancelled` first — the
   * caller asked for it to vanish, not for an audit trail. Live workers
   * receive a kill signal and the workdir is destroyed.
   *
   * `opts.force` skips the load-and-validate step and removes the
   * directory whenever it exists on disk. Without this, a `task.json`
   * that fails schema validation (corruption, future
   * `CURRENT_SCHEMA_VERSION` bump) would leave the directory
   * undeletable through the public API — `loadTask` would return
   * `null`, `delete` would throw `TaskNotFoundError`, and operators
   * would have to shell in to the workspace to clean up. With
   * `force: true`, the directory's mere existence is enough to allow
   * removal, mirroring `rm -rf` semantics.
   */
  async delete(id: string, opts: { force?: boolean } = {}): Promise<void> {
    assertValidTaskId(id);
    const workdir = safeJoinUnderRoot(this.tasksDir, id);

    if (opts.force === true) {
      // Existence check via stat(): we still want a 404 if the dir
      // truly doesn't exist (so the dashboard's optimistic UI can
      // distinguish "already gone" from "deleted now"), but we don't
      // care whether the task.json inside parses.
      let dirExists: boolean;
      try {
        const st = await stat(workdir);
        dirExists = st.isDirectory();
      } catch {
        dirExists = false;
      }
      if (!dirExists) {
        throw new TaskNotFoundError(id);
      }
    } else {
      const existing = await this.loadTask(id, workdir);
      if (existing === null) {
        throw new TaskNotFoundError(id);
      }
    }

    const live = this.live.get(id);
    if (live !== undefined) {
      // Drop from live first so the exit watcher's `this.live.delete(id)`
      // is a no-op and doesn't race with our rm. Then kill + drain.
      //
      // We await `settled` rather than `handle.exit` so the exit watcher
      // has finished its post-exit `applyTerminal()` write before we
      // start the rm. Otherwise the watcher's `writeFile(task.json)` and
      // our `rm(workdir, recursive)` race: whichever loses logs a noisy
      // ENOENT-driven "failed to persist terminal status" warn even
      // though the task is being deliberately discarded. `settled` never
      // rejects (the watcher catches everything internally), so the
      // try/catch is purely defensive.
      this.live.delete(id);
      // Mark the task as killed-by-us BEFORE invoking kill(): the exit
      // watcher might fire its 'exit' handler synchronously (via the
      // Promise resolve queue) the moment we call kill(), so the flag
      // must be set first. With it set, the watcher records `failure`
      // — though for delete() the workdir is rm'd anyway, so the
      // applyTerminal write is wasted. (We accept that small cost in
      // exchange for not racing rm against writeFile.)
      live.killedByUs = true;
      try {
        live.handle.kill();
      } catch {
        // Already dead. Continue.
      }
      try {
        await live.settled;
      } catch {
        // Defensive — settled is constructed to never reject.
      }
    }

    await rm(workdir, { recursive: true, force: true });
  }

  // ─── recoverOrphaned ─────────────────────────────────────

  /**
   * Sweep `tasksDir` and reconcile any persisted task whose status is
   * still `running`. Called once at server bootstrap so a task whose
   * owner-process crashed (or was kill -9'd) doesn't show up as
   * forever-running in the dashboard.
   *
   * Scope: this method is the **server-crash** safety net only. Normal
   * stop, `pm2 reload`, and `nodemon` restart all deliver SIGTERM/SIGINT
   * and run `gracefulShutdown`, which kills every live subprocess and
   * persists `failure: "server shutdown"` *before* the process exits.
   * By the time `recoverOrphaned` runs at the next bootstrap, those
   * tasks are already terminal and skipped here. Only a hard crash —
   * OOM, segfault, `kill -9`, power loss — can reach this code path
   * with a `running` task.
   *
   * For each `running` task we probe whether the recorded PID is still
   * alive (`process.kill(pid, 0)`):
   *
   *   - **Dead**: the subprocess is gone, the task is genuinely
   *     orphaned, mark it `failure` with the canonical reason.
   *   - **Alive**: a child somehow outlived the server crash (PID 1
   *     adoption, OS quirk, brief race where we boot before the
   *     OS has reaped). Leave the task at `running` and log a warn —
   *     no exit watcher will see this subprocess finish, so the task
   *     will likely sit at `running` until next reconciliation, but
   *     incorrectly flipping it to `failure` while real work is still
   *     being written into the workdir is worse than a stale row.
   *   - **Unknown PID** (no `metadata.pid` recorded): pre-1.0 records
   *     or third-party producers; treat as dead and mark `failure`,
   *     matching pre-PID-probe behaviour.
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

          const pid = readTaskRuntimeMetadata(task).pid;
          if (typeof pid === "number" && isProcessAlive(pid)) {
            this.logger.warn(
              "tasks: skipping live orphan (subprocess outlived server crash; will not be watched)",
              { taskId: id, pid },
            );
            return;
          }

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
      // Mark the task as killed-by-us before invoking kill(), so the
      // exit watcher's decideTerminal() call records `failure: server
      // shutdown` rather than reading the natural exit reason. Per-task
      // scope (rather than a global flag) means another task that
      // self-exits cleanly mid-shutdown is still classified as
      // `success` — the kill flag only flips for tasks we actually
      // killed.
      l.killedByUs = true;
      try {
        l.handle.kill();
      } catch {
        // Already dead — let the exit watcher run its course.
      }
    }
    // Wait for every exit watcher to finish persisting its terminal
    // status. The watcher reads `liveEntry.killedByUs` AT exit time to
    // decide between "server shutdown" and the natural exit reason.
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
        // `output: ""` is intentional under the runtime-driven completion
        // model: the kernel records that the agent finished cleanly, but
        // does not synthesise a "what did it produce" string. The agent's
        // real artifacts live on disk under `<workdir>/` and the runtime's
        // event stream sits at `<workdir>/session/`. See the JSDoc on
        // `TaskResult` in ./types.ts and the long-term design discussion.
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
 *   - killedByUs    → failure, "server shutdown" (regardless of code/signal,
 *                     because we asked for it via `delete()` or `shutdown()`)
 *   - exit code 0   → success
 *   - exit code N   → failure, "exited with code N"
 *   - signal X      → failure, "terminated by signal X"
 *
 * The `killedByUs` flag is read AT exit time from the per-task LiveTask
 * record (not at the moment shutdown began), so a clean self-exit with
 * `code: 0` racing against `shutdown()` is still classified as `success`
 * unless this manager actually invoked `kill()` for this task.
 */
function decideTerminal(
  exitInfo: { code: number | null; signal: NodeJS.Signals | null },
  killedByUs: boolean,
): TerminalDecision {
  if (killedByUs) {
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

/**
 * Probe whether `pid` names a live process this user can signal.
 *
 * Uses `process.kill(pid, 0)` — the Node + POSIX + Windows-emulated idiom
 * for "exists + permitted". Signal `0` performs the existence check
 * without actually delivering anything. The semantics:
 *
 *   - process exists and we can signal it → returns true
 *   - process is gone (`ESRCH`) → returns false
 *   - process exists but we lack permission (`EPERM`) → returns true
 *     (we still know it's alive)
 *
 * Any other error is treated as "unknown / probably gone" so the caller
 * defaults to the safer mark-as-failure path.
 *
 * Note on PID reuse: between a server crash and the next bootstrap, the
 * OS may have recycled the PID we recorded. `isProcessAlive` cannot
 * detect this — it'll see the new occupant and return true. The
 * consequence (one task incorrectly stays at `running` instead of being
 * marked `failure`) is a strictly milder failure mode than the
 * pre-probe code's symmetric mistake (incorrectly flipping a live
 * subprocess to `failure`), so the trade is favourable.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

export type { TaskRuntimeMetadata } from "./task-file.js";
// Re-export typed metadata reader so consumers don't have to dig into
// `task-file.js`.
export { readTaskRuntimeMetadata } from "./task-file.js";
