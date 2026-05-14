import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentResolveResult, CatalogManager } from "@emploke/catalog";
import type { Logger } from "@emploke/logger";
import { silentLogger } from "@emploke/logger";
import type { Runtime, RuntimeHandle, RuntimeRegistry } from "@emploke/runtime";
import {
  AgentNotFoundError,
  EntryNotReadyError,
  RuntimeDoesNotSupportTasksError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
} from "./errors.js";
import {
  framingPromptFor,
  TASK_ARTIFACT_SUBDIR,
  TASK_FILENAME,
  TASK_TEMP_SUBDIR,
} from "./framing.js";
import { assertValidTaskId, generateTaskId } from "./ids.js";
import { safeJoinUnderRoot } from "./paths.js";
import type { TaskRepository } from "./repositories/repository.js";
import { Task } from "./task-entity.js";
import { readTaskRuntimeMetadata } from "./task-meta.js";
import type { DispatchOpts, ListTaskOpts, TaskManagerConfig } from "./types.js";

const DEFAULT_RUNTIME = "copilot";
const MAX_CREATE_RETRIES = 5;

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
  readonly handle: RuntimeHandle;
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
 * captured `stderr.log` and whatever the agent itself wrote during
 * execution. The queryable metadata (status, runtime, agent, timings,
 * the open-shape `metadata` bag) lives in the per-workspace
 * `workspace.db` (in the `tasks` table) — one row per task, owned by
 * the SQLite repository. The runtime keeps
 * its own per-task event log on its own state directory (Copilot:
 * `<copilotStateDir>/<runtimeSessionId>/events.jsonl`); emploke does
 * NOT mirror it back into the workdir.
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
  private readonly catalog: CatalogManager;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly defaultRuntime: string;
  private readonly tasksDir: string;
  private readonly workspaceDir: string;
  private readonly workspaceId: string | undefined;
  private readonly subprocessEnvBase: NodeJS.ProcessEnv;
  private readonly repository: TaskRepository;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;
  private readonly framingPromptByRuntime: Readonly<Record<string, string>> | undefined;

  /** id → live record for tasks whose subprocess this manager still owns. */
  private readonly live = new Map<string, LiveTask>();

  /**
   * Ids whose `dispatch()` call is between workdir reservation and the
   * `live.set` at the end of dispatch. The on-disk task record exists
   * during this window (`mkdir` + `persist(initial)` + possibly
   * `persist(running)` have already run), but the `LiveTask` entry is
   * not yet installed.
   *
   * Surfaced via `liveCount()` so callers like `WorkspaceContextCache.reload`
   * — which uses a non-zero count to refuse to evict the cached
   * `TaskManager` — see in-flight dispatches as "live" too. Without
   * this, a reload landing in the window between the workdir mkdir
   * and `live.set` would evict the manager, the next request would
   * lazy-build a fresh `TaskManager` whose `recoverOrphaned` sweep
   * runs against the half-written disk row. (`recoverOrphaned` does
   * have a PID-alive probe that prevents the worst-case flip to
   * failure for already-running tasks, but the old manager would
   * still be a ghost holding the subprocess handle, and the new
   * manager's first list/refresh would miss the row until terminal.)
   *
   * The brief instant where an id appears in BOTH `live` and
   * `dispatchInProgress` — between `live.set` at the end of the
   * dispatch body and the surrounding `finally { dispatchInProgress.delete }`
   * — is sub-tick (synchronous within the same microtask) and double-
   * counts in `liveCount()`. Deliberate: over-count is fail-safe for
   * reload (it errs on the side of refusal, never of permitting an
   * unsafe eviction).
   */
  private readonly dispatchInProgress = new Set<string>();

  /** True once `shutdown()` has been called; gates exit-watcher's status decision. */
  private shuttingDown = false;

  constructor(config: TaskManagerConfig) {
    this.catalog = config.catalog;
    this.runtimeRegistry = config.runtimeRegistry;
    this.defaultRuntime = config.defaultRuntime ?? DEFAULT_RUNTIME;
    this.tasksDir = path.resolve(config.tasksDir);
    this.workspaceDir = path.resolve(config.workspaceDir);
    this.workspaceId = config.workspaceId;
    this.subprocessEnvBase = config.subprocessEnv ?? {};
    this.logger = config.logger ?? silentLogger;
    this.repository = config.repository;
    this.now = config.now ?? (() => new Date());
    this.randomBytes = config.randomBytes ?? defaultRandomBytes;
    this.framingPromptByRuntime = config.framingPromptByRuntime;
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
      // Status guard: refuse dispatch on blocked agents. The cascade-
      // aware status from `getAgentEntry` means we catch:
      //   - prereqs not acknowledged on the agent itself
      //   - agent disabled by user
      //   - any transitive skill missing / blocked
      // Pre-existing behaviour (silent acceptance) was a footgun — the
      // runtime would spawn and then fail with a much less clear error.
      const entry = await this.catalog.getAgentEntry(agentName);
      if (entry === null) {
        throw new AgentNotFoundError(agentName);
      }
      if (entry.status === "blocked") {
        throw new EntryNotReadyError(agentName, entry.blockedReason);
      }
      resolveResult = await this.catalog.resolveAgent(agentName);
    } catch (err) {
      if (err instanceof AgentNotFoundError || err instanceof EntryNotReadyError) {
        throw err;
      }
      throw new AgentNotFoundError(agentName, err as Error);
    }

    // 2. Pick the runtime + verify it supports tasks. We do this before
    //    reserving the workdir so a misconfiguration doesn't litter empty
    //    dirs on disk.
    const runtimeKind = opts.runtime ?? this.defaultRuntime;
    const runtime = this.runtimeRegistry.get(runtimeKind);
    if (typeof runtime.launchHeadless !== "function") {
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

    // From this point on the workdir exists on disk, so a freshly
    // constructed sibling `TaskManager` for the same `tasksDir` —
    // e.g. one built after `WorkspaceContextCache.reload` evicts us —
    // could see this row. Mark `id` as in-flight so `liveCount()`
    // refuses such evictions until the `LiveTask` entry below is
    // installed. Cleared in the `finally` regardless of which exit
    // path we take (rollback throw vs success return).
    this.dispatchInProgress.add(id);
    try {
      return await this.runDispatch({
        id,
        workdir,
        agentName,
        instructions: opts.instructions,
        runtime,
        resolveResult,
      });
    } finally {
      this.dispatchInProgress.delete(id);
    }
  }

  private async runDispatch(args: {
    id: string;
    workdir: string;
    agentName: string;
    instructions: string;
    runtime: Runtime;
    resolveResult: AgentResolveResult;
  }): Promise<Task> {
    const { id, workdir, agentName, instructions, runtime, resolveResult } = args;
    // Re-narrow `runtime.launchHeadless` for TypeScript. The caller
    // (`dispatch()`) already checked this and throws `RuntimeDoesNotSupportTasksError`
    // before reserving the workdir, so this guard is only here to
    // restore the type narrow that's lost across the method boundary —
    // we deliberately do NOT extract `launchHeadless` to a local because
    // that would break the `this`-binding for runtime impls that read
    // own state (e.g. the `RealSpawnRuntime` test fixture).
    if (typeof runtime.launchHeadless !== "function") {
      throw new RuntimeDoesNotSupportTasksError(runtime.kind);
    }

    // 4. Persist the initial Task in `not_started`. If anything below
    //    fails, we rollback the workdir entirely — pre-spawn failures
    //    should not leave a ghost failure-status task on disk (per the
    //    Task FSM, `fail` is only legal from `running`, so we'd have to
    //    persist a status the kernel doesn't permit anyway).
    const createdAt = this.now().toISOString();
    const initial = Task.create({
      id,
      agent: agentName,
      instructions,
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

    // 4b. Materialize the user's instructions to `<workdir>/TASK.md`
    //     and create the agent-managed `temp/` + `artifact/`
    //     subdirectories. See packages/task/src/framing.ts for why
    //     instructions live in a file rather than the spawn argv
    //     (issue #109 — Bug A: cmd.exe argv-LF interaction silently
    //     dropping copilot CLI flags on Windows). Failure here is
    //     pre-spawn, so we roll back the workdir to mirror the
    //     existing pre-spawn rollback pattern (no ghost row/dir).
    try {
      await writeFile(path.join(workdir, TASK_FILENAME), instructions, {
        encoding: "utf8",
      });
      await mkdir(path.join(workdir, TASK_TEMP_SUBDIR), { recursive: true });
      await mkdir(path.join(workdir, TASK_ARTIFACT_SUBDIR), { recursive: true });
    } catch (err) {
      await safeRm(workdir, this.logger);
      throw err;
    }

    // 5. Spawn. The runtime owns the subprocess and gives us back a
    //    handle. Failures here (provision throws, spawn ENOENT, ...) are
    //    pre-running, so we rollback the workdir and rethrow.
    let handle: RuntimeHandle;
    try {
      handle = await runtime.launchHeadless({
        workdir,
        agent: resolveResult,
        catalog: this.catalog,
        // Fixed single-line ASCII framing prompt (per runtime kind).
        // The user's `instructions` is NOT passed via argv anymore —
        // it lives byte-for-byte in `<workdir>/TASK.md` (written
        // above) and the framing prompt tells the agent to read it.
        prompt: framingPromptFor(runtime.kind, this.framingPromptByRuntime),
        workspaceDir: this.workspaceDir,
        // Self-describing context bag the subprocess (and any
        // grandchildren it spawns through `emploke ...` calls)
        // inherits via process.env. Merged with the static base
        // (server URL, API key, shared dir) supplied at construction
        // time. See LaunchHeadlessOpts.subprocessEnv for the rationale.
        //
        // CONCURRENCY: this object literal is freshly allocated on
        // every dispatch — never cache it on `this`. The base is
        // frozen (see `buildSubprocessEnvBase`) so the spread is the
        // only mutable layer. Two concurrent dispatches each build
        // their own object with their own `id`, then hand them to
        // `runtime.launchHeadless` which hands them to `spawn`,
        // which copies into the OS at process-create time — the
        // env stops being shared the instant the child is up.
        subprocessEnv: {
          ...this.subprocessEnvBase,
          ...(this.workspaceId !== undefined ? { EMPLOKE_WORKSPACE: this.workspaceId } : {}),
          EMPLOKE_WORKSPACE_DIR: this.workspaceDir,
          EMPLOKE_RUN_KIND: "task",
          EMPLOKE_RUN_ID: id,
          EMPLOKE_RUN_DIR: workdir,
        },
      });
    } catch (err) {
      await safeRm(workdir, this.logger);
      throw err;
    }

    // 5b. Re-check `shuttingDown` after spawn. The flag is read once at
    //     the top of `dispatch()`, but `await runtime.launchHeadless(...)`
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
    const running = initial.start({
      metadata: startMetaPatch,
      now: this.now().toISOString(),
    });
    await this.persist(workdir, running);

    // 7. Wire post-spawn background work: watch for exit and persist
    //    the terminal status. The runtime owns its own per-task state
    //    dir (Copilot puts events.jsonl in
    //    `<copilotStateDir>/<runtimeSessionId>/`); we no longer mirror
    //    it into the task workdir. The dashboard fetches the parsed
    //    activity through `runtime.readActivity`, which reads the
    //    runtime's native log directly. We expose a `settled` promise
    //    so `shutdown()` and tests can await drain.
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
      // 7a. Wait for exit + apply terminal status. The runtime owns
      //     its own per-task state dir (Copilot puts events.jsonl in
      //     `<copilotStateDir>/<runtimeSessionId>/`); we don't
      //     mirror it back into the task workdir. The dashboard
      //     fetches the parsed activity through
      //     `runtime.readActivity`, which reads the runtime's native
      //     log directly without going through the manager.
      let exitInfo: Awaited<RuntimeHandle["exit"]>;
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
   * Filters in `opts` are applied server-side by the SQLite repository
   * (which holds the indexes), so the manager returns only the rows the
   * caller asked for. This mirrors `@emploke/session`'s
   * `list(ListSessionOpts)` pattern and lets the dashboard push its
   * filter UI down to the server (so e.g. an "agent: writer" filter
   * doesn't ship the other 95% of the workspace's tasks across the
   * wire on every poll).
   */
  async list(opts: ListTaskOpts = {}): Promise<Task[]> {
    // Push every filter (status, agent, runtime, createdSince) down to
    // the SQLite repository so the dashboard's filter UI hits a single
    // indexed query instead of the old O(N) `readdir` + per-row read +
    // JS filter pattern. The repository's own list silently drops
    // corrupted rows and warns via our injected logger, so callers see
    // the same "skip-and-warn" semantics they had under the FS impl —
    // just emitted from one layer down.
    let tasks: Task[];
    try {
      tasks = await this.repository.list(opts);
    } catch (err) {
      this.logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
        },
        "tasks: repository.list failed",
      );
      return [];
    }

    // Newest first. createdAt is ISO 8601 → lexicographic sort. Id is
    // the deterministic tiebreaker for tasks created in the same
    // millisecond. (We sort here rather than in the repository so the
    // sort order is owned by one place and stays consistent across
    // future repo backends.)
    tasks.sort((a, b) => {
      const d = b.createdAt.localeCompare(a.createdAt);
      return d !== 0 ? d : b.id.localeCompare(a.id);
    });

    // Enrich with runtime-supplied display metadata (title, etc.) in
    // parallel. Each call is one small file read on the runtime's
    // own state dir; we Promise.all so a list of N tasks pays
    // O(1) wall-clock instead of O(N). Failures are silent — title
    // is a nice-to-have, the dashboard falls through to instructions.
    return Promise.all(tasks.map((t) => this.enrichWithRuntimeMetadata(t)));
  }

  // ─── get ─────────────────────────────────────────────────

  async get(id: string): Promise<Task | null> {
    assertValidTaskId(id);
    const workdir = safeJoinUnderRoot(this.tasksDir, id);
    const task = await this.loadTask(id, workdir);
    if (task === null) return null;
    return this.enrichWithRuntimeMetadata(task);
  }

  // ─── getTaskActivity / getTaskActivityStream ─────────────

  /**
   * Fetch a task's activity timeline + derived headline result via
   * the runtime's structured activity surface. Returns `null` when:
   *   - the task is missing or its metadata is corrupted,
   *   - the runtime is no longer registered,
   *   - the runtime doesn't implement `readActivity` (no structured
   *     log support),
   *   - the runtime has no log for this task yet (task hasn't started,
   *     or started but hasn't emitted its first event).
   *
   * The route layer maps `null` to 404 NoEventsYet.
   *
   * Pagination is owned by the runtime (it's the only layer that
   * knows its own log layout); the manager just forwards
   * `before` / `after` / `limit` and the runtime's `truncated` marker.
   * The server route enforces the [1, 500] limit clamp and the
   * `before`/`after` mutex before reaching here.
   *
   * Read errors after the runtime found its log (e.g. permission
   * error mid-read) propagate; they're true server faults and should
   * surface as 500.
   */
  async getTaskActivity(
    id: string,
    opts?: { readonly before?: number; readonly after?: number; readonly limit?: number },
  ): Promise<import("@emploke/runtime").ActivityResult | null> {
    const task = await this.get(id);
    if (task === null) return null;
    const meta = readTaskRuntimeMetadata(task);
    if (typeof meta.runtime !== "string") return null;
    const runtimeSessionId = pickRuntimeSessionId(task.metadata);
    if (runtimeSessionId === null) return null;
    let runtime: import("@emploke/runtime").Runtime;
    try {
      runtime = this.runtimeRegistry.get(meta.runtime);
    } catch {
      // The recorded runtime is no longer registered. Treat as "no
      // events available" — dashboard renders NoEventsYet, the right
      // UX for an unrecoverable task.
      return null;
    }
    if (typeof runtime.readActivity !== "function") return null;
    return runtime.readActivity({
      runtimeSessionId,
      ...(opts?.before !== undefined ? { before: opts.before } : {}),
      ...(opts?.after !== undefined ? { after: opts.after } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    });
  }

  /**
   * Live-tail variant of {@link getTaskActivity}. Returns the
   * runtime's `streamActivity` AsyncIterable, or `null` when:
   *   - same null cases as `getTaskActivity` (missing task,
   *     unregistered runtime, no streaming support), OR
   *   - the task is already terminal (live tail has nothing more
   *     to deliver — caller should use the bounded
   *     `getTaskActivity` for post-mortem reads).
   *
   * The caller (SSE route) is responsible for closing the stream
   * when the HTTP client disconnects via `opts.signal`. The
   * runtime's iterator MUST honour the signal and clean up file
   * handles / watchers within a few hundred ms.
   */
  async getTaskActivityStream(
    id: string,
    opts: { readonly after?: number; readonly signal?: AbortSignal },
  ): Promise<AsyncIterable<import("@emploke/runtime").ActivityItem> | null> {
    const task = await this.get(id);
    if (task === null) return null;
    // Streaming a terminal task is wasted work — the iterator would
    // immediately yield nothing and close. Force callers to use the
    // one-shot endpoint for that case.
    if (task.status !== "running" && task.status !== "not_started") return null;
    const meta = readTaskRuntimeMetadata(task);
    if (typeof meta.runtime !== "string") return null;
    const runtimeSessionId = pickRuntimeSessionId(task.metadata);
    if (runtimeSessionId === null) return null;
    let runtime: import("@emploke/runtime").Runtime;
    try {
      runtime = this.runtimeRegistry.get(meta.runtime);
    } catch {
      return null;
    }
    if (typeof runtime.streamActivity !== "function") return null;
    return runtime.streamActivity({
      runtimeSessionId,
      ...(opts.after !== undefined ? { after: opts.after } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  // ─── delete ──────────────────────────────────────────────

  /**
   * Remove a task. Default ("archive") removes only the task's metadata
   * row; the workdir is left on disk so the user can inspect agent
   * artifacts after the fact.
   *
   * `{ purge: true }` is the hard-delete path:
   *   1. Kill any live subprocess (always; metadata removal alone would
   *      orphan it).
   *   2. Ask the runtime to wipe its per-task state (e.g. Copilot's
   *      `<copilotStateDir>/<runtimeSessionId>/`) via
   *      `runtime.deleteState`. Runtime first so a permission-denied
   *      or network failure aborts BEFORE any local removal — same
   *      ordering as `SessionManager.delete`. Runtimes without per-task
   *      state simply omit the method and we skip this step.
   *   3. Remove the metadata row from the repository.
   *   4. `rm -rf` the workdir.
   *
   * `purge: true` also implies "skip metadata validation" — a task
   * whose metadata row is corrupted or missing (parse failure, future
   * `CURRENT_SCHEMA_VERSION` bump, stray workdir from a prior emploke
   * version) would otherwise be undeletable through the public API.
   * Mirrors `rm -rf` semantics for that recovery path; we skip the
   * runtime state cleanup in that case because there's no metadata
   * to read the runtime session id from.
   *
   * Throws `TaskNotFoundError` when no task with `id` exists (and, in
   * default mode, when the metadata is unreadable).
   */
  async delete(id: string, opts: { purge?: boolean } = {}): Promise<void> {
    assertValidTaskId(id);
    const workdir = safeJoinUnderRoot(this.tasksDir, id);

    // Resolve the existing task (metadata row) when we can. In purge
    // mode we still try to load it so we can hand metadata to the
    // runtime for state cleanup — but we tolerate failure and fall
    // back to the directory-existence check (rm -rf semantics).
    let existing: Task | null = null;
    try {
      existing = await this.loadTask(id, workdir);
    } catch (err) {
      if (opts.purge !== true) throw err;
      // purge mode: corrupted row is acceptable; we'll detect via stat below.
    }

    if (opts.purge === true) {
      if (existing === null) {
        // Existence check via stat(): we still want a 404 if the dir
        // truly doesn't exist (so the dashboard's optimistic UI can
        // distinguish "already gone" from "deleted now"), but we
        // accept a missing/corrupt metadata row.
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
      }
    } else if (existing === null) {
      throw new TaskNotFoundError(id);
    }

    const live = this.live.get(id);
    if (live !== undefined) {
      this.live.delete(id);
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

    if (opts.purge === true && existing !== null) {
      // Wipe the runtime's per-task state BEFORE we touch local rows
      // / workdir, so a runtime failure leaves a recoverable state
      // (row + workdir intact, user can retry). No-op when the
      // runtime doesn't implement the optional hook, or when the
      // metadata doesn't carry the keys it needs.
      const runtimeName = existing.metadata.runtime;
      const runtimeKey = typeof runtimeName === "string" ? runtimeName : this.defaultRuntime;
      let runtime: Runtime;
      try {
        runtime = this.runtimeRegistry.get(runtimeKey);
      } catch {
        // Unknown runtime (e.g. dropped from registry between dispatch
        // and delete): nothing to call into. Skip and proceed with the
        // local cleanup so the user can still get rid of the task.
        runtime = undefined as unknown as Runtime;
      }
      if (runtime !== undefined && typeof runtime.deleteState === "function") {
        const runtimeSessionId = pickRuntimeSessionId(existing.metadata);
        if (runtimeSessionId !== null) {
          await runtime.deleteState(runtimeSessionId);
        }
      }
    }

    // Always remove metadata via the repository (otherwise a SQLite
    // backend would leave a ghost row). For purge=true, ALSO rm the
    // entire workdir; for default, agent-produced files under
    // <tasksDir>/<id>/ are preserved for archival.
    await this.repository.delete(id);
    if (opts.purge === true) {
      await rm(workdir, { recursive: true, force: true });
    }
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
    // The DB row is the source of truth for "this task exists in
    // emploke's view of the world". A workdir on disk without a row
    // is a stray dir (typical cause: dispatch crashed before the
    // first save), not an orphan task — `recoverOrphaned` deliberately
    // leaves those for a separate cleanup. So a single SQL query for
    // status='running' is the complete candidate set.
    let candidates: Task[];
    try {
      candidates = await this.repository.list({ statuses: ["running"] });
    } catch (err) {
      this.logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
        },
        "tasks: recoverOrphaned repository.list failed",
      );
      return;
    }

    await Promise.all(
      candidates.map(async (task) => {
        const id = task.id;
        const workdir = safeJoinUnderRoot(this.tasksDir, id);

        const pid = readTaskRuntimeMetadata(task).pid;
        if (typeof pid === "number" && isProcessAlive(pid)) {
          this.logger.warn(
            { taskId: id, pid },
            "tasks: skipping live orphan (subprocess outlived server crash; will not be watched)",
          );
          return;
        }

        try {
          const failed = task.fail("orphaned (server crashed before this task ended)", {
            now: this.now().toISOString(),
          });
          await this.persist(workdir, failed);
        } catch (err) {
          this.logger.warn(
            {
              taskId: id,
              error: err instanceof Error ? err.message : String(err),
            },
            "tasks: failed to mark orphaned task as failure",
          );
        }
      }),
    );
  }

  // ─── shutdown ────────────────────────────────────────────

  /**
   * Number of tasks the manager is currently supervising — both fully
   * "live" entries (subprocess spawned, exit watcher armed) and
   * dispatches mid-flight (workdir reserved, on-disk row written, but
   * not yet registered in `live`). A task is counted from the moment
   * its workdir is created in `dispatch()` and stays counted until
   * either the dispatch errors out (rollback) or its exit watcher has
   * persisted the terminal status (`live.delete(id)` runs).
   *
   * Useful for callers that need to refuse / defer destructive operations
   * — e.g. workspace cache reload, where evicting the cached
   * `WorkspaceContext` mid-task would orphan the subprocess from this
   * manager's view and leave the next request's fresh `recoverOrphaned`
   * sweep racing the original exit watcher to write the terminal row.
   *
   * The `+ dispatchInProgress.size` summand closes the window between
   * `mkdir(workdir)` in `dispatch()` and the final `live.set` — without
   * it a reload landing in that window would see `liveCount() === 0`
   * even though an on-disk row already exists. See `dispatchInProgress`
   * jsdoc for full reasoning.
   */
  liveCount(): number {
    return this.live.size + this.dispatchInProgress.size;
  }

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

  // ─── close ───────────────────────────────────────────────

  /**
   * Release the underlying repository handle. After `close()`, the
   * manager must not be used. Idempotent.
   *
   * Servers that swap or evict a `TaskManager` (e.g. `WorkspaceContextCache`
   * on workspace removal / cache reload) must call this so the SQLite
   * file handle releases — Windows requires it before the workspace
   * directory can be `rm`-ed. `shutdown()` deliberately does NOT call
   * `close()` because consumers commonly inspect persisted state
   * (`m.get(id)`) after shutdown to confirm terminal-status writes
   * completed; closing the DB out from under those reads would defeat
   * the inspection. Call `close()` separately when you're truly done
   * with the manager.
   */
  close(): void {
    const repo = this.repository as { close?: () => void };
    if (typeof repo.close === "function") {
      try {
        repo.close();
      } catch {
        // best-effort
      }
    }
  }

  // ─── internals ───────────────────────────────────────────

  /**
   * Read + validate the persisted task at `workdir`, or null when no
   * row exists for `id`.
   *
   * `CorruptedTaskError` from the repository is **propagated**, not
   * swallowed. The route layer maps it to 5xx so operators see the
   * corruption (a silent 404 would let the dashboard render "task
   * gone" for what is really tampered/bit-rotted metadata, hiding the
   * problem until next save round-trips an empty `{}` over the corrupt
   * blob). The `delete --purge` caller catches the propagated error
   * and falls through to the stat-based escape hatch — see `delete()`
   * above. The `list()` path does NOT go through this method; it
   * skip+warns at the repo layer (see `SqliteTaskRepository.list`).
   */
  private async loadTask(id: string, _workdir: string): Promise<Task | null> {
    const task = await this.repository.read(id);
    if (task === null) return null;
    if (task.id !== id) {
      // Defensive: directory name and id-in-row disagree. Trust the
      // directory name (it's how we found this) and surface a warning.
      this.logger.warn(
        {
          taskId: id,
          persistedId: task.id,
        },
        "tasks: id mismatch between dir and persisted row",
      );
    }
    return task;
  }

  /**
   * Fold runtime-supplied display metadata (title, etc.) into a
   * loaded task. Returns the same task object when:
   *   - the runtime is unknown / unregistered (silent)
   *   - the runtime doesn't implement `readMetadata` (silent)
   *   - the runtime returns null (no title available yet)
   *   - the runtime call throws (logged at debug; we fall back to
   *     the persisted view)
   *
   * On success, returns a NEW task object with `metadata.title`
   * (and `metadata.userTitled` / `metadata.lastActiveAtRuntime`)
   * merged in. Pure — never mutates the input task.
   *
   * Does NOT persist. Title is derived from the runtime's own
   * source of truth (Copilot's `workspace.yaml`); persisting our
   * snapshot would just duplicate state that the runtime can
   * regenerate on demand. The dashboard / CLI sees the latest
   * value on every list/get call without a write loop.
   *
   * Honours the runtime's `userTitled` flag: when true, the user
   * has explicitly renamed via the runtime CLI, so consumers
   * SHOULD treat the title as authoritative even if a future
   * regenerate path tries to overwrite. We surface the flag so
   * the dashboard's own rename UX (when added) can defer to it.
   */
  private async enrichWithRuntimeMetadata(task: Task): Promise<Task> {
    const runtimeName = task.metadata.runtime;
    if (typeof runtimeName !== "string") return task;
    let runtime: Runtime;
    try {
      runtime = this.runtimeRegistry.get(runtimeName);
    } catch {
      return task;
    }
    if (typeof runtime.readMetadata !== "function") return task;
    const runtimeSessionId = pickRuntimeSessionId(task.metadata);
    if (runtimeSessionId === null) return task;
    let meta: Awaited<ReturnType<NonNullable<Runtime["readMetadata"]>>>;
    try {
      meta = await runtime.readMetadata(runtimeSessionId);
    } catch (err) {
      // Title is best-effort; don't break list/get on a runtime fault.
      this.logger.warn(
        {
          taskId: task.id,
          runtime: runtimeName,
          error: err instanceof Error ? err.message : String(err),
        },
        "tasks: readMetadata failed",
      );
      return task;
    }
    if (meta === null) return task;
    // Open-shape merge — only set the keys we care about, preserve
    // everything else verbatim.
    const enriched: Record<string, unknown> = { ...task.metadata };
    if (meta.title !== null) enriched.title = meta.title;
    enriched.userTitled = meta.userTitled;
    if (meta.lastActiveAt !== null) enriched.lastActiveAtRuntime = meta.lastActiveAt;
    return task.withMetadata(enriched);
  }

  /** Atomic write of the persisted record. */
  private async persist(_workdir: string, task: Task): Promise<void> {
    await this.repository.save(task);
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
        next = running.complete("", {
          metadata: metaPatch,
          now: this.now().toISOString(),
        });
      } else {
        next = running.fail(decision.reason, {
          metadata: metaPatch,
          now: this.now().toISOString(),
        });
      }
      await this.persist(workdir, next);
    } catch (err) {
      this.logger.warn(
        {
          taskId: running.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "tasks: failed to persist terminal status",
      );
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
    logger.warn(
      {
        path: p,
        error: err instanceof Error ? err.message : String(err),
      },
      "tasks: failed to remove workdir during cleanup",
    );
  }
}

function defaultRandomBytes(n: number): Buffer {
  return cryptoRandomBytes(n);
}

/**
 * Pull a runtime-shaped session id out of the task's open-shape
 * metadata bag. Returns null when the field is missing or not a
 * string — caller treats null as "no runtime session for this task,
 * skip the runtime-side operation".
 *
 * Centralised so dispatch / activity / delete / metadata all read
 * the same key with the same defensiveness.
 */
function pickRuntimeSessionId(metadata: Readonly<Record<string, unknown>>): string | null {
  const v = metadata.runtimeSessionId;
  return typeof v === "string" && v.length > 0 ? v : null;
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

export type { TaskRuntimeMetadata } from "./task-meta.js";
// Re-export typed metadata reader so consumers don't have to dig into
// `task-meta.js`.
export { readTaskRuntimeMetadata } from "./task-meta.js";
