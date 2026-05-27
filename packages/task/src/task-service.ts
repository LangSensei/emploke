import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentResolveResult, CatalogService } from "@emploke/catalog";
import type { Runtime, RuntimeHandle, RuntimeRegistry } from "@emploke/runtime";
import pino, { type Logger } from "pino";
import {
  AgentNotFoundError,
  EntryNotReadyError,
  InvalidTransition,
  ManagerShuttingDownError,
  RuntimeDoesNotSupportTasksError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
} from "./errors.js";
import {
  formatTaskMd,
  TASK_ARTIFACT_SUBDIR,
  TASK_FILENAME,
  TASK_FRAMING_PROMPT_COPILOT,
  TASK_TEMP_SUBDIR,
} from "./framing.js";
import { safeJoinUnderRoot, tasksRoot } from "./paths.js";
import { TaskEntity } from "./task-entity.js";
import { readTaskRuntimeMetadata } from "./task-meta.js";
import { TaskRepository } from "./task-repository.js";
import type {
  DispatchOpts,
  ListTaskOpts,
  TaskCancellation,
  TaskFailure,
  TaskOrigin,
  TaskServiceConfig,
} from "./types.js";
import { assertValidTaskId, generateTaskId } from "./validate.js";
import { listWorkdirFiles } from "./workdir.js";

const silentLogger = pino({ level: "silent" });

const DEFAULT_RUNTIME = "copilot";
const MAX_CREATE_RETRIES = 5;

/**
 * Maximum number of characters retained from the agent's final
 * assistant utterance into {@link TaskSuccess.output}. The full text is
 * already preserved in the runtime's activity log; this cap exists only
 * to keep the persisted task row a sensible size for list / detail
 * reads.
 *
 * Truncation is applied to the **tail** (`slice(0, MAX)`) so the
 * opening of the summary — typically the most informative part, often
 * containing the URL of the PR the agent opened or a one-line headline
 * — is always preserved. An earlier revision used `slice(-MAX)` and
 * silently dropped the leading characters when the reply exceeded the
 * cap (see iter-2 B2 fix).
 */
const TASK_OUTPUT_MAX_CHARS = 8000;

/**
 * In-memory record for a task whose subprocess we still own. Once the
 * subprocess exits and the post-exit fs writes complete, the entry is
 * dropped from the map.
 *
 * `killReason` is the mutable flag the exit watcher reads AT exit time
 * to classify the terminal status. It says "why did this manager
 * invoke handle.kill() for this task". Values:
 *   - `null`       — subprocess exited on its own (success / non-zero / signal)
 *   - `'shutdown'` — `TaskService.shutdown()` killed it (server going down)
 *   - `'cancel'`   — `TaskService.cancel(id)` killed it (user-initiated)
 *
 * `delete()` no longer sets this — after ADR-001, `delete()` requires
 * the task be terminal and never kills a subprocess. Orphan recovery
 * is a separate code path (`recoverOrphaned()` at boot) and also
 * doesn't go through `decideTerminal`.
 *
 * CONCURRENT WRITE SEMANTICS: `cancel()` and `shutdown()` can both
 * reach the same `LiveTask`. The design is last-write-wins for the
 * `killReason` slot. In practice they don't compete: `shutdown()`
 * acquires the global `shuttingDown` flag before iterating, and
 * `cancel()` refuses if `shuttingDown` is true. The only window
 * where both can fire is when `cancel()` has passed its
 * `shuttingDown` check and dropped into the live-kill block at the
 * exact moment `shutdown()` begins. The outcome (terminal kind =
 * 'cancelled' OR 'failure: shutdown') is non-deterministic but BOTH
 * outcomes are semantically correct — the task did not finish on
 * its own, the recorded reason names a real cause. The
 * cancel-during-shutdown test accepts either. We do NOT add a
 * first-write-wins helper because the non-determinism is irreducible
 * and harmless.
 *
 * Within a single verb, concurrent cancel() invocations DO coordinate:
 * the first call observes `killReason === null` and "owns" the kill;
 * subsequent concurrent callers observe `killReason === 'cancel'`,
 * await the same `settled` promise, and then throw
 * `InvalidTransition('cancelled', 'cancel')` so the route maps to
 * 409 for the second + third + Nth caller. This pins
 * cancel-concurrent-same-id (ADR test T3).
 */
interface LiveTask {
  readonly id: string;
  readonly handle: RuntimeHandle;
  /** Resolves once the post-exit persistence has finished (success or failure path). */
  readonly settled: Promise<void>;
  /**
   * Why this manager invoked handle.kill() for this task. Read by the
   * exit watcher AT exit time to classify the terminal state.
   */
  killReason: "shutdown" | "cancel" | null;
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
 * The TaskEntity value type itself is the FSM; this class just orchestrates
 * persistence + side effects around it.
 */
export class TaskService {
  private readonly catalog: CatalogService;
  private readonly runtimeRegistry: RuntimeRegistry;
  private readonly tasksDir: string;
  private readonly workspaceDir: string;
  private readonly workspaceId: string;
  private readonly repository: TaskRepository;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Buffer;

  /** id → live record for tasks whose subprocess this manager still owns. */
  private readonly live = new Map<string, LiveTask>();

  /**
   * Ids whose `dispatch()` call is between workdir reservation and the
   * `live.set` at the end of dispatch. The on-disk task record exists
   * during this window (`mkdir` + `persist(initial)` + possibly
   * `persist(running)` have already run), but the `LiveTask` entry is
   * not yet installed.
   *
   * Surfaced via `liveCount()` so callers like `WorkspaceContextRegistry.reload`
   * — which uses a non-zero count to refuse to evict the cached
   * `TaskService` — see in-flight dispatches as "live" too. Without
   * this, a reload landing in the window between the workdir mkdir
   * and `live.set` would evict the manager, the next request would
   * lazy-build a fresh `TaskService` whose `recoverOrphaned` sweep
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

  constructor(config: TaskServiceConfig) {
    this.catalog = config.catalog;
    this.runtimeRegistry = config.runtimeRegistry;
    this.workspaceDir = path.resolve(config.workspaceDir);
    this.tasksDir = tasksRoot(this.workspaceDir);
    this.workspaceId = config.workspaceId;
    this.logger = config.logger ?? silentLogger;
    this.repository = new TaskRepository({ db: config.db, logger: this.logger });
    this.now = config.now ?? (() => new Date());
    this.randomBytes = config.randomBytes ?? defaultRandomBytes;
  }

  // ─── dispatch ────────────────────────────────────────────

  async dispatch(opts: DispatchOpts): Promise<TaskEntity> {
    if (this.shuttingDown) {
      // Refuse new work once shutdown has been called. Avoids a race where
      // a request is mid-flight when the SIGTERM lands and we end up
      // spawning a subprocess we have to immediately kill. ADR-001
      // promoted this to a typed error so the route layer maps to 503
      // (was: bare Error falling through to 400).
      throw new ManagerShuttingDownError();
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
    const runtimeKind = opts.runtime ?? DEFAULT_RUNTIME;
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
    // constructed sibling `TaskService` for the same `tasksDir` —
    // e.g. one built after `WorkspaceContextRegistry.reload` evicts us —
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
        brief: opts.brief,
        details: opts.details,
        origin: opts.origin ?? "standalone",
        runtime,
        resolveResult,
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      });
    } finally {
      this.dispatchInProgress.delete(id);
    }
  }

  private async runDispatch(args: {
    id: string;
    workdir: string;
    agentName: string;
    brief: string;
    details: string | undefined;
    origin: TaskOrigin;
    runtime: Runtime;
    resolveResult: AgentResolveResult;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<TaskEntity> {
    const { id, workdir, agentName, brief, details, origin, runtime, resolveResult } = args;
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

    // 4. Persist the initial TaskEntity. Status is `running` from create
    //    time (v4 dropped the `not_started` placeholder — see TaskStatus).
    //    If anything below fails, we roll back the workdir entirely;
    //    pre-spawn failures should not leave a ghost row on disk.
    //
    //    Spread order is intentional: caller-supplied `metadata` first,
    //    kernel keys (workdir, runtime) override. Lets schedulers and
    //    other orchestrators tag a task at dispatch time (e.g.
    //    `metadata: { scheduleId, firedAt }`) without giving them a
    //    way to spoof the runtime column (`task-repository.ts` promotes
    //    `metadata.runtime` to a first-class indexed column on save and
    //    folds it back on read — divergence would mislead the runtime
    //    filter / dashboard).
    const createdAt = this.now().toISOString();
    const initialMeta: Record<string, unknown> = {
      ...(args.metadata ?? {}),
      workdir,
      runtime: runtime.kind,
    };
    const initial = TaskEntity.create({
      id,
      agent: agentName,
      brief,
      ...(details !== undefined ? { details } : {}),
      origin,
      createdAt,
      metadata: initialMeta,
    });
    try {
      await this.persist(workdir, initial);
    } catch (err) {
      await safeRm(workdir, this.logger);
      throw err;
    }

    // 4b. Materialize the user's brief (+ optional details) to
    //     `<workdir>/TASK.md` and create the agent-managed `temp/` +
    //     `artifact/` subdirectories. See packages/task/src/framing.ts
    //     for why the body lives in a file rather than the spawn
    //     argv (issue #109 — Bug A: cmd.exe argv-LF interaction
    //     silently dropping copilot CLI flags on Windows). Failure
    //     here is pre-spawn, so we roll back the workdir to mirror
    //     the existing pre-spawn rollback pattern (no ghost row/dir).
    try {
      await writeFile(path.join(workdir, TASK_FILENAME), formatTaskMd(brief, details), {
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
        // Fixed single-line ASCII framing prompt. The user's
        // `brief` + `details` are NOT passed via argv anymore — they
        // live byte-for-byte in `<workdir>/TASK.md` (written above)
        // and the framing prompt tells the agent to read it. Today
        // `copilot` is the only headless-capable runtime; when a
        // second one arrives, switch on `runtime.kind` here.
        prompt: TASK_FRAMING_PROMPT_COPILOT,
        workspaceDir: this.workspaceDir,
        // Per-task work-context env. The runtime layers its own
        // cross-cutting env (`EMPLOKE_SERVER`, `EMPLOKE_SHARED_DIR`,
        // ...) underneath via its `subprocessEnvBase` config — we
        // only emit the work identification fields here.
        subprocessEnv: {
          EMPLOKE_WORKSPACE: this.workspaceId,
          EMPLOKE_WORKSPACE_DIR: this.workspaceDir,
          EMPLOKE_WORK_KIND: "task",
          EMPLOKE_WORK_ID: id,
          EMPLOKE_WORK_DIR: workdir,
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
      throw new ManagerShuttingDownError();
    }

    // 6. Fold runtime-session id into metadata (the runtime supplies it
    //    after spawn). Status is already `running` from create-time, so
    //    there is no separate state transition here; we just refresh
    //    the metadata bag and persist. A write failure here would leave
    //    us inconsistent (subprocess up, disk lacks the runtimeSessionId
    //    needed to find its event log), so we do NOT roll back — we
    //    surface the error to the caller with the subprocess still live
    //    and the row still on disk. The orphan recovery path will mark
    //    it failed at the next bootstrap if the server then restarts.
    let running: TaskEntity = initial;
    if (handle.runtimeSessionId !== undefined) {
      running = initial.withMetadata({
        ...initial.metadata,
        runtimeSessionId: handle.runtimeSessionId,
      });
      await this.persist(workdir, running);
    }

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
      killReason: null,
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
        // resolve, never reject. Classify as `internal` so the failure
        // wire shape carries a typed kind operators can branch on.
        await this.applyTerminal(workdir, running, {
          kind: "failed",
          failure: {
            kind: "internal",
            message: `exit watcher rejected: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
        this.live.delete(id);
        return;
      }

      // Read killReason AT exit time, per the LiveTask JSDoc. If the
      // task self-exited cleanly with `code: 0` while `shutdown()` was
      // running but had not yet invoked `kill()` for this task, this
      // flag is still null and we record `success`.
      const decision = decideTerminal(exitInfo, liveEntry.killReason);
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
  async list(opts: ListTaskOpts = {}): Promise<TaskEntity[]> {
    // Push every filter (status, agent, runtime, createdSince) down to
    // the SQLite repository so the dashboard's filter UI hits a single
    // indexed query instead of the old O(N) `readdir` + per-row read +
    // JS filter pattern. The repository's own list silently drops
    // corrupted rows and warns via our injected logger, so callers see
    // the same "skip-and-warn" semantics they had under the FS impl —
    // just emitted from one layer down.
    let tasks: TaskEntity[];
    try {
      tasks = await this.repository.list(opts);
    } catch (err) {
      this.logger.warn({ err }, "tasks: repository.list failed");
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

    // Per ADR-002: list() no longer fans out one runtime.readMetadata
    // call per row. The runtime read is a per-task fs.stat behind a
    // libuv worker; at workspace scale (dozens of tasks polled every
    // few seconds) this saturated the default 4-thread pool and
    // serialised the purge fs.rm path. `lastActiveAtRuntime` is only
    // meaningful for live tasks anyway, so enrichment now lives on
    // `get()` and only fires when status==='running'. Callers that
    // need the runtime-recency field for a list row must call
    // `get(id)` per task they want to enrich.
    return tasks;
  }

  // ─── hasInFlightForSchedule ─────────────────────────────────

  /**
   * True if any non-terminal task with `origin='schedule'` and
   * `metadata.scheduleId === scheduleId` exists. Used by the
   * scheduler's concurrency=1 check (skip fire if previous still
   * running) and by the delete-schedule guard (refuse delete while a
   * fired task is still in flight). Cheap thanks to the
   * `tasks_schedule_id_idx` functional index added in PR 1 of #61.
   */
  async hasInFlightForSchedule(scheduleId: string): Promise<boolean> {
    return this.repository.hasInFlightForSchedule(scheduleId);
  }

  // ─── get ─────────────────────────────────────────────────

  async get(id: string): Promise<TaskEntity | null> {
    assertValidTaskId(id);
    const workdir = safeJoinUnderRoot(this.tasksDir, id);
    const task = await this.loadTask(id, workdir);
    if (task === null) return null;
    // ADR-002: only running tasks have a meaningful
    // `lastActiveAtRuntime`. For terminal tasks the runtime state
    // dir may already be gone (purge runs in background) and the
    // field has no consumer.
    if (task.status !== "running") return task;
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
    if (task.status !== "running") return null;
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

  // ─── cancel ──────────────────────────────────────────────

  /**
   * User-initiated cancellation of a live task. Kills the subprocess
   * (SIGTERM via the runtime's best-effort `handle.kill()`), waits
   * for the exit watcher to persist the terminal status, and returns
   * the cancelled `TaskEntity` (status='cancelled', `cancellation.kind='user'`).
   *
   * Contract:
   *   - **Idempotency**: terminal-state input throws
   *     {@link InvalidTransition}; route maps to 409. Concurrent
   *     `cancel(id)` calls also collapse to the same terminal write —
   *     the first call owns the kill, subsequent calls await the same
   *     `live.settled` and then throw {@link InvalidTransition}.
   *   - **Orphan-safe**: if the task is `running` but has no live
   *     entry (an undetected orphan that `recoverOrphaned` missed),
   *     synthesises a terminal decision and routes through
   *     `applyTerminal` so the persisted row has the same shape as
   *     the normal-path output. Logs a warn so the operator knows
   *     `recoverOrphaned` has a gap. No error to user.
   *   - **Race defence (ADR-001 R-1)**: refuses with
   *     {@link InvalidTransition} if `dispatchInProgress.has(id)` is
   *     true. External HTTP callers can't reach this branch (id is
   *     unknown until dispatch returns), but pinning the invariant
   *     protects future internal callers (queueing, agent
   *     self-extension, parallel test fixtures, etc).
   *   - **Awaits `live.settled`** before returning so the next read
   *     sees `cancelled`.
   *   - **Throws {@link TaskNotFoundError}** if the id doesn't exist.
   *   - **Refuses while shutting down**: throws
   *     {@link ManagerShuttingDownError}. The route layer maps this
   *     to 503 (mirrors the dispatch() refusal).
   */
  async cancel(id: string): Promise<TaskEntity> {
    assertValidTaskId(id);
    if (this.shuttingDown) throw new ManagerShuttingDownError();

    // R-1 defence: refuse if a concurrent dispatch is mid-flight for
    // this id. External HTTP callers cannot reach this branch (the id
    // is unknown until dispatch returns); kept to pin the invariant for
    // internal callers (queueing, agent self-extension, parallel test
    // fixtures, etc).
    if (this.dispatchInProgress.has(id)) {
      throw new InvalidTransition("running", "cancel-during-dispatch");
    }

    const workdir = safeJoinUnderRoot(this.tasksDir, id);
    const existing = await this.loadTask(id, workdir);
    if (existing === null) throw new TaskNotFoundError(id);
    if (
      existing.status === "succeeded" ||
      existing.status === "failed" ||
      existing.status === "cancelled"
    ) {
      throw new InvalidTransition(existing.status, "cancel");
    }

    const live = this.live.get(id);
    if (live !== undefined) {
      // Concurrent-cancel coordination: the first caller observes
      // `killReason === null` and "owns" the kill. Subsequent callers
      // observe the prior reason, await the same `settled` promise,
      // and then throw InvalidTransition so the route maps to 409
      // for the second + Nth caller. Pins T3.
      const wasFirstToCancel = live.killReason === null;
      if (wasFirstToCancel) {
        live.killReason = "cancel";
        try {
          live.handle.kill();
        } catch {
          // Already dead.
        }
      }
      try {
        await live.settled;
      } catch {
        // settled is constructed to never reject.
      }
      if (!wasFirstToCancel) {
        throw new InvalidTransition("cancelled", "cancel");
      }
    } else {
      // Orphan path: undetected by recoverOrphaned. Route through
      // applyTerminal with a synthesised decision so the persisted row
      // shape matches the normal-path output. v4 folded the orphan
      // cancellation variant into `cascade`, since no caller branches
      // on the orphan flavour specifically.
      this.logger.warn(
        { taskId: id },
        "tasks: cancelling row in running status with no live subprocess (orphan)",
      );
      await this.applyTerminal(workdir, existing, {
        kind: "cancelled",
        cancellation: {
          kind: "cascade",
          message: "cancelled (recovered from inconsistent state)",
        },
      });
    }

    const final = await this.loadTask(id, workdir);
    if (final === null) throw new TaskNotFoundError(id);
    return final;
  }

  // ─── delete ──────────────────────────────────────────────

  /**
   * Remove a task. Post-ADR-001 this verb only ever removes records —
   * it never touches subprocesses. The task MUST be in a terminal
   * status (`success` / `failure` / `cancelled`) before `delete()` is
   * called; non-terminal input throws {@link InvalidTransition} and
   * the route layer maps that to 409 (use `cancel()` first if the
   * task is still running).
   *
   * Default ("archive") removes only the task's metadata row; the
   * workdir is left on disk so the user can inspect agent artifacts
   * after the fact.
   *
   * `{ purge: true }` is the hard-delete path:
   *   1. Remove the metadata row from the repository — synchronous,
   *      awaited; this is the user-facing "task is gone" semantic.
   *   2. Schedule a background job (via `setImmediate`) that:
   *      a. Calls `runtime.deleteState(<runtimeSessionId>)` to wipe
   *         the runtime's per-task state (e.g. Copilot's
   *         `<copilotStateDir>/<runtimeSessionId>/`). Runtimes without
   *         per-task state simply omit the method and we skip this.
   *      b. `rm -rf` the workdir.
   *
   * Filesystem cleanup is fire-and-forget: failures are logged at
   * warn level and otherwise swallowed. On Windows the per-task state
   * dir can be hundreds of MB and an in-line `rm` can take tens of
   * seconds (Defender + per-file unlink), which would freeze the
   * dashboard's DELETE response. Orphan dirs left behind by a failed
   * background rm are recoverable via the manual cleanup channel
   * (sqlite3 CLI / `rm -rf` on disk) per ADR-001 §3.5.
   *
   * Throws `TaskNotFoundError` when no task with `id` exists.
   * Throws `InvalidTransition(currentStatus, 'delete')` when the task
   * exists but is not terminal.
   */
  async delete(id: string, opts: { purge?: boolean } = {}): Promise<void> {
    assertValidTaskId(id);
    const workdir = safeJoinUnderRoot(this.tasksDir, id);

    const existing = await this.loadTask(id, workdir);
    if (existing === null) {
      throw new TaskNotFoundError(id);
    }
    if (
      existing.status !== "succeeded" &&
      existing.status !== "failed" &&
      existing.status !== "cancelled"
    ) {
      // ADR-001 §3.5: delete requires terminal status. Cancel the
      // task first (POST /tasks/:id/cancel; emploke task cancel <tid>)
      // before deleting.
      throw new InvalidTransition(existing.status, "delete");
    }

    // DB row removal IS the "task is deleted" semantic; the user-facing
    // 204 hinges on this. Done synchronously and in-process so the
    // caller can rely on a successful resolve meaning "this task no
    // longer exists from the API's POV".
    await this.repository.delete(id);

    if (opts.purge === true) {
      // Filesystem cleanup is fire-and-forget. On Windows the per-task
      // copilot state dir can be hundreds of MB and rm can take tens of
      // seconds (Defender + per-file unlink). We refuse to stall the
      // HTTP response for that. Failures here are logged at warn level
      // — the resulting orphan dirs are recoverable manually per
      // ADR-001 §3.5 (sqlite3 CLI / manual cleanup).
      this.scheduleBackgroundPurge(id, existing, workdir);
    }
  }

  /**
   * Test seam: serialised chain of background purges scheduled by
   * `scheduleBackgroundPurge`. Production code MUST NOT read this —
   * tests use `_drainPendingPurgesForTest()` to await completion.
   *
   * Per ADR-002 we replaced the original `Set<Promise> + setImmediate`
   * fan-out with a single chained promise. fs.rm of a copilot state
   * dir on Windows holds a libuv worker for tens of seconds; running
   * N purges in parallel starved the (4-thread default) pool and
   * starved every other fs-bound call on the server (dashboard polls,
   * config reads). Serial purge keeps at most one libuv worker pinned
   * regardless of how many deletes the user fired.
   */
  private purgeQueue: Promise<void> = Promise.resolve();

  private scheduleBackgroundPurge(id: string, existing: TaskEntity, workdir: string): void {
    // Chain serially through `purgeQueue`. The assignment is synchronous
    // so `_drainPendingPurgesForTest()` invoked immediately after
    // `delete(...)` observes the in-flight chain. We supply BOTH the
    // resolved and rejected continuations so a prior purge failure
    // never stalls the queue — every subsequent purge gets to run.
    this.purgeQueue = this.purgeQueue.then(
      () => this.runBackgroundPurge(id, existing, workdir),
      () => this.runBackgroundPurge(id, existing, workdir),
    );
  }

  private async runBackgroundPurge(
    id: string,
    existing: TaskEntity,
    workdir: string,
  ): Promise<void> {
    const runtimeName = existing.metadata.runtime;
    const runtimeKey = typeof runtimeName === "string" ? runtimeName : DEFAULT_RUNTIME;
    let runtime: Runtime | undefined;
    try {
      runtime = this.runtimeRegistry.get(runtimeKey);
    } catch {
      // Unknown runtime (e.g. dropped from registry between dispatch
      // and delete): nothing to call into. Skip and proceed with the
      // workdir rm so the user still loses the local copy.
      runtime = undefined;
    }

    if (runtime !== undefined && typeof runtime.deleteState === "function") {
      const runtimeSessionId = pickRuntimeSessionId(existing.metadata);
      if (runtimeSessionId !== null) {
        try {
          await runtime.deleteState(runtimeSessionId);
        } catch (err) {
          this.logger.warn(
            { err, taskId: id, runtimeSessionId },
            "task.purge: runtime.deleteState failed; orphan runtime state dir may remain",
          );
        }
      }
    }

    try {
      await rm(workdir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(
        { err, taskId: id, workdir },
        "task.purge: workdir rm failed; orphan task workdir may remain",
      );
    }
  }

  /**
   * @internal Test-only: await all in-flight background purges
   * scheduled by `delete({ purge: true })`. Not part of the public
   * API; the underscore prefix marks this as a test seam. Awaits the
   * tail of `purgeQueue`, which serialises every scheduled purge.
   */
  async _drainPendingPurgesForTest(): Promise<void> {
    await this.purgeQueue;
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
   * Lifecycle invariant: the underlying CLI subprocess is owned by
   * the SDK (`@github/copilot-sdk`), which spawns it as a child of
   * the emploke server process. When the server dies, the OS reaps
   * the SDK CLI subprocess; there is no scenario where the CLI
   * outlives the server. So every `running` task at boot is
   * genuinely orphaned — no per-task liveness probe is needed.
   */
  async recoverOrphaned(): Promise<void> {
    // The DB row is the source of truth for "this task exists in
    // emploke's view of the world". A workdir on disk without a row
    // is a stray dir (typical cause: dispatch crashed before the
    // first save), not an orphan task — `recoverOrphaned` deliberately
    // leaves those for a separate cleanup. So a single SQL query for
    // status='running' is the complete candidate set.
    let candidates: TaskEntity[];
    try {
      candidates = await this.repository.list({ statuses: ["running"] });
    } catch (err) {
      this.logger.warn({ err }, "tasks: recoverOrphaned repository.list failed");
      return;
    }

    await Promise.all(
      candidates.map(async (task) => {
        const id = task.id;
        const workdir = safeJoinUnderRoot(this.tasksDir, id);

        try {
          const failed = task.fail(
            {
              kind: "orphan",
              message: "orphaned (server crashed before this task ended)",
            },
            {
              now: this.now().toISOString(),
            },
          );
          await this.persist(workdir, failed);
        } catch (err) {
          this.logger.warn(
            {
              taskId: id,
              err,
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
      // Mark the task as killed-by-shutdown before invoking kill(), so
      // the exit watcher's decideTerminal() call records `failure: {
      // kind:'shutdown' }` rather than reading the natural exit reason.
      // Per-task scope (rather than a global flag) means another task
      // that self-exits cleanly mid-shutdown is still classified as
      // `success` — the kill flag only flips for tasks we actually
      // killed.
      l.killReason = "shutdown";
      try {
        l.handle.kill();
      } catch {
        // Already dead — let the exit watcher run its course.
      }
    }
    // Wait for every exit watcher to finish persisting its terminal
    // status. The watcher reads `liveEntry.killReason` AT exit time
    // to decide between `failure: shutdown` / `cancelled` / natural.
    await Promise.allSettled(snapshot.map((l) => l.settled));
  }

  // ─── close ───────────────────────────────────────────────

  /**
   * Release the underlying repository handle. After `close()`, the
   * manager must not be used. Idempotent.
   *
   * Servers that swap or evict a `TaskService` (e.g. `WorkspaceContextRegistry`
   * on workspace removal / cache reload) must call this so the SQLite
   * file handle releases — Windows requires it before the workspace
   * directory can be `rm`-ed. `shutdown()` deliberately does NOT call
   * `close()` because consumers commonly inspect persisted state
   * (`m.get(id)`) after shutdown to confirm terminal-status writes
   * completed; closing the DB out from under those reads would defeat
   * the inspection. Call `close()` separately when you're truly done
   * with the manager.
   *
   * Currently a no-op: the DB handle is owned by the composer
   * (`composeTaskModule`), which closes it from its own `close()`.
   * Kept on the public surface so future callers don't break if we
   * ever add manager-owned resources.
   */
  close(): void {
    // no-op — db lifecycle owned by composeTaskModule
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
   * skip+warns at the repo layer (see `TaskRepository.list`).
   */
  private async loadTask(id: string, _workdir: string): Promise<TaskEntity | null> {
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
   * Fold runtime-supplied display metadata (lastActiveAtRuntime)
   * into a loaded task. Returns the same task object when:
   *   - the runtime is unknown / unregistered (silent)
   *   - the runtime doesn't implement `readMetadata` (silent)
   *   - the runtime returns null (no metadata available yet)
   *   - the runtime call throws (logged; we fall back to the
   *     persisted view)
   *
   * On success, returns a NEW task object with
   * `metadata.lastActiveAtRuntime` merged in. Pure — never
   * mutates the input task.
   *
   * Does NOT persist. The runtime's own state is the source of
   * truth; persisting our snapshot would just duplicate state that
   * the runtime can regenerate on demand. The dashboard / CLI sees
   * the latest value on every list/get call without a write loop.
   *
   * NOTE: the legacy `metadata.title` / `metadata.userTitled` keys
   * are deliberately NOT injected here anymore. Post-#109 the
   * Copilot-generated session `name` reflects the framing prompt,
   * not the user's task, so the derived title was actively
   * misleading as a task headline. The TaskEntity entity's first-class
   * `brief` field is now the source of truth for the displayed
   * label. `readCopilotWorkspaceYaml` itself stays — it's still
   * used by `Session` for the session preview field.
   */
  private async enrichWithRuntimeMetadata(task: TaskEntity): Promise<TaskEntity> {
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
      // lastActiveAtRuntime is best-effort; don't break list/get on a
      // runtime fault.
      this.logger.warn(
        {
          taskId: task.id,
          runtime: runtimeName,
          err,
        },
        "tasks: readMetadata failed",
      );
      return task;
    }
    if (meta === null) return task;
    if (meta.lastActiveAt === null) return task;
    // Open-shape merge — only set the keys we care about, preserve
    // everything else verbatim.
    const enriched: Record<string, unknown> = {
      ...task.metadata,
      lastActiveAtRuntime: meta.lastActiveAt,
    };
    return task.withMetadata(enriched);
  }

  /** Atomic write of the persisted record. */
  private async persist(_workdir: string, task: TaskEntity): Promise<void> {
    await this.repository.save(task);
  }

  /**
   * Apply the terminal event to a running task and persist. v4
   * (issue #119) dropped the convention of mirroring `exitCode` /
   * `exitSignal` into the open-shape `metadata` bag — those values
   * now live exclusively inside `failure.exit_code` / `failure.signal`
   * when relevant (`exited` / `signal` variants). Consumers that
   * previously read `metadata.exitCode` should branch on `failure.kind`
   * and read the typed field instead.
   */
  private async applyTerminal(
    workdir: string,
    running: TaskEntity,
    decision: TerminalDecision,
  ): Promise<void> {
    let next: TaskEntity;
    try {
      switch (decision.kind) {
        case "succeeded": {
          // Per issue #181: collect a 500-char tail of the agent's
          // last assistant utterance plus the absolute paths of every
          // file under `<workdir>/artifact/` and persist them as part
          // of the terminal write. Both sub-collectors are
          // best-effort — any failure degrades to ("", []) and warns,
          // never blocks the transition.
          const [output, artifacts] = await this.collectSuccessPayload(workdir, running);
          next = running.complete(
            { output, artifacts },
            {
              now: this.now().toISOString(),
            },
          );
          break;
        }
        case "failed":
          next = running.fail(decision.failure, {
            now: this.now().toISOString(),
          });
          break;
        case "cancelled":
          next = running.cancel(decision.cancellation, {
            now: this.now().toISOString(),
          });
          break;
      }
      await this.persist(workdir, next);
    } catch (err) {
      this.logger.warn(
        {
          taskId: running.id,
          err,
        },
        "tasks: failed to persist terminal status",
      );
    }
  }

  /**
   * Best-effort assembly of {@link TaskSuccess} payload at terminal
   * time (issue #181). Asks the runtime for its last agent-produced
   * activity (via {@link Runtime.getLastAgentActivity}) and caps it
   * for `output`; lists `<workdir>/artifact/` for the artifact paths.
   * Tolerant of all failures: returns `[null, []]` on any sub-failure
   * and logs a warn. Never blocks the terminal transition.
   *
   * The split of concerns: the runtime knows what "agent-produced"
   * means in its own event stream (so picking-the-right-event is
   * runtime-domain); TaskService owns the persistence cap and the
   * artifact directory layout (both task-domain). Runtime never sees
   * "success" or "final" framing — success/failure is a TaskService
   * concept layered on top of a neutral activity stream.
   *
   * The two sub-collectors are kicked off in parallel so the wall-clock
   * cost is the slower of (one runtime call, one `<workdir>/artifact/`
   * readdir) rather than their sum.
   */
  private async collectSuccessPayload(
    workdir: string,
    task: TaskEntity,
  ): Promise<[string | null, readonly string[]]> {
    const runtimeName = task.metadata.runtime;
    const runtimeSessionId = pickRuntimeSessionId(task.metadata);

    const outputP: Promise<string | null> = (async () => {
      if (typeof runtimeName !== "string" || runtimeSessionId === null) return null;
      let runtime: Runtime;
      try {
        runtime = this.runtimeRegistry.get(runtimeName);
      } catch {
        return null;
      }
      if (typeof runtime.getLastAgentActivity !== "function") return null;
      try {
        const last = await runtime.getLastAgentActivity(runtimeSessionId);
        if (last === null) return null;
        // Preserve the head of the agent's final message; only cap the
        // tail. Earlier code used `slice(-MAX)` which silently dropped
        // the opening characters when the final reply exceeded MAX —
        // breaking links and sentences that conventionally open the
        // summary (e.g. "Done. PR opened at …"). A head cap loses
        // trailing detail (typically less critical) and never produces
        // a body that looks subtly corrupt.
        return last.text.slice(0, TASK_OUTPUT_MAX_CHARS);
      } catch (err) {
        this.logger.warn(
          { taskId: task.id, err },
          "tasks: applyTerminal getLastAgentActivity failed; output left null",
        );
        return null;
      }
    })();

    const artifactsP: Promise<readonly string[]> = (async () => {
      try {
        return await listWorkdirFiles(workdir, TASK_ARTIFACT_SUBDIR);
      } catch (err) {
        this.logger.warn(
          { taskId: task.id, err },
          "tasks: applyTerminal listWorkdirFiles failed; artifacts left empty",
        );
        return [];
      }
    })();

    return Promise.all([outputP, artifactsP]);
  }

  /**
   * Resolve a downloadable artifact for a terminal task. Returns the
   * absolute fs path when the named artifact is on the task's
   * whitelist (`task.success.artifacts`), or `null` when the task is
   * unknown / non-terminal / missing the artifact entirely. The
   * caller (server route) maps `null` to 404 and streams the path.
   *
   * The whitelist check is the actual security boundary: only
   * artifacts emitted by the agent at terminal time can be served.
   * Path traversal in the request name is defensively rejected at the
   * route layer; the manager additionally normalises with
   * `path.basename` here so any sneaky separator pasted from the
   * route never participates in the join.
   */
  async resolveArtifactPath(id: string, name: string): Promise<string | null> {
    assertValidTaskId(id);
    const task = await this.get(id);
    if (task === null) return null;
    if (task.status === "running") return null;
    const allowed = task.success?.artifacts ?? [];
    // Match by basename — the persisted entries are absolute paths
    // under `<workdir>/artifact/`; HTTP callers only ever know the
    // leaf filename. `path.basename` normalises both unix and
    // windows separators so cross-platform persisted rows resolve
    // identically.
    const requested = path.basename(name);
    if (requested === "" || requested === "." || requested === "..") return null;
    const match = allowed.find((abs) => path.basename(abs) === requested);
    if (match === undefined) return null;
    return match;
  }
}

// ─── module-private helpers ────────────────────────────────

/**
 * Outcome of classifying a subprocess exit. Discriminated by `kind`
 * so {@link TaskService.applyTerminal} can dispatch typed transitions
 * to the entity (`complete` / `fail` / `cancel`). v4 (issue #119)
 * dropped the parallel `exitCode` / `exitSignal` fields here — the
 * exit-code / signal context, when relevant, lives inside the typed
 * `failure` payload (`exited` / `signal` variants).
 */
type TerminalDecision =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly failure: TaskFailure }
  | { readonly kind: "cancelled"; readonly cancellation: TaskCancellation };

/**
 * Translate a subprocess exit into a typed terminal decision.
 *
 *   - killReason === 'cancel'   → cancelled, kind='user'
 *   - killReason === 'shutdown' → failed,    kind='shutdown'
 *   - exit code 0               → succeeded
 *   - exit code N (non-zero)    → failed,    kind='exited'
 *   - exit signal X             → failed,    kind='signal'
 */
function decideTerminal(
  exitInfo: { code: number | null; signal: NodeJS.Signals | null },
  killReason: "shutdown" | "cancel" | null,
): TerminalDecision {
  if (killReason === "cancel") {
    return {
      kind: "cancelled",
      cancellation: { kind: "user", message: "cancelled by user" },
    };
  }
  if (killReason === "shutdown") {
    return {
      kind: "failed",
      failure: { kind: "shutdown", message: "server shutdown" },
    };
  }
  if (exitInfo.code === 0) {
    return { kind: "succeeded" };
  }
  if (exitInfo.signal !== null) {
    return {
      kind: "failed",
      failure: {
        kind: "signal",
        signal: exitInfo.signal,
        message: `terminated by signal ${exitInfo.signal}`,
      },
    };
  }
  return {
    kind: "failed",
    failure: {
      kind: "exited",
      exit_code: exitInfo.code as number,
      message: `exited with code ${exitInfo.code}`,
    },
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
        err,
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

export type { TaskRuntimeMetadata } from "./task-meta.js";
// Re-export typed metadata reader so consumers don't have to dig into
// `task-meta.js`.
export { readTaskRuntimeMetadata } from "./task-meta.js";
