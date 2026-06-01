import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentResolveResult,
  AgentNotFoundError as CatalogAgentNotFoundError,
} from "@emploke/catalog";
import type { Runtime, RuntimeHandle } from "@emploke/runtime";
import type { Logger } from "pino";
import {
  AgentNotFoundError,
  AgentResolutionFailedError,
  EntryNotReadyError,
  ManagerShuttingDownError,
  RuntimeDoesNotSupportTasksError,
} from "../errors.js";
import {
  formatTaskMd,
  TASK_ARTIFACT_SUBDIR,
  TASK_FILENAME,
  TASK_FRAMING_PROMPT_COPILOT,
  TASK_TEMP_SUBDIR,
} from "../framing.js";
import { TaskEntity } from "../task-entity.js";
import type { TaskServiceCtx } from "../task-service.js";
import type { TaskCancellation, TaskFailure, TaskOrigin } from "../types.js";
import { applyTerminal } from "./mutations.js";

/**
 * In-memory record for a task whose subprocess we still own. Dropped
 * from the map once the subprocess exits and the post-exit fs writes
 * complete.
 *
 * `killReason` is the mutable flag the exit watcher reads AT exit
 * time to classify terminal status — "why did this manager invoke
 * `handle.kill()`":
 *   - `null`       — subprocess exited on its own
 *   - `'shutdown'` — `TaskService.shutdown()` killed it
 *   - `'cancel'`   — `TaskService.cancel(id)` killed it
 *
 * Concurrent semantics: last-write-wins for `killReason`. `cancel()`
 * and `shutdown()` rarely race (shutdown takes the global flag
 * first); when they do, either terminal kind is semantically correct
 * and the cancel-during-shutdown test accepts either. Concurrent
 * `cancel(id)` calls DO coordinate via the `wasFirstToCancel` check
 * in `cancelTask` — pins ADR test T3.
 */
export interface LiveTask {
  readonly id: string;
  readonly handle: RuntimeHandle;
  /** Resolves once the post-exit persistence has finished. */
  readonly settled: Promise<void>;
  killReason: "shutdown" | "cancel" | null;
}

/**
 * Outcome of classifying a subprocess exit. Discriminated by `kind`
 * so `applyTerminal` can dispatch typed transitions to the entity.
 * v4 (issue #119) keeps `exit_code` / `signal` strictly inside the
 * `failure` payload.
 */
export type TerminalDecision =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly failure: TaskFailure }
  | { readonly kind: "cancelled"; readonly cancellation: TaskCancellation };

/**
 * Translate a subprocess exit into a typed terminal decision:
 * killReason 'cancel' → cancelled/user; 'shutdown' → failed/shutdown;
 * exit code 0 → succeeded; non-zero → failed/exited; signal → failed/signal.
 */
export function decideTerminal(
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
export async function safeRm(p: string, logger: Logger): Promise<void> {
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

/**
 * Resolve an agent name to a runnable `AgentResolveResult` via the
 * catalog. Performs the cascade-aware status check — refuses dispatch
 * on blocked agents (prereqs not acknowledged, agent disabled, or
 * any transitive skill missing/blocked). Throws `AgentNotFoundError`
 * for unknown agents, `EntryNotReadyError` for blocked entries, and
 * `AgentResolutionFailedError` (500) for unexpected catalog faults.
 */
export async function resolveDispatchAgent(
  ctx: TaskServiceCtx,
  agentName: string,
): Promise<AgentResolveResult> {
  try {
    const entry = await ctx.catalog.getAgentEntry(agentName);
    if (entry === null) {
      throw new AgentNotFoundError(agentName);
    }
    if (entry.status === "blocked") {
      throw new EntryNotReadyError(agentName, entry.blockedReason);
    }
    return await ctx.catalog.resolveAgent(agentName);
  } catch (err) {
    // Pass through this layer's own throws (each is already shaped
    // for the route layer).
    if (err instanceof AgentNotFoundError || err instanceof EntryNotReadyError) {
      throw err;
    }
    // Catalog said "agent does not exist" → present as user error (400).
    if (err instanceof CatalogAgentNotFoundError) {
      throw new AgentNotFoundError(agentName, err);
    }
    // Any other catalog failure is a system fault — surface as 500
    // with the cause preserved for `5xx fault` logs.
    throw new AgentResolutionFailedError(agentName, err);
  }
}

/**
 * Look up a runtime by kind and verify it supports headless task
 * launch. Throws `RuntimeDoesNotSupportTasksError` if the runtime is
 * registered but cannot launch tasks. Called before reserving a
 * workdir so a misconfiguration doesn't litter empty dirs on disk.
 */
export function pickRuntime(ctx: TaskServiceCtx, runtimeKind: string): Runtime {
  const runtime = ctx.runtimeRegistry.get(runtimeKind);
  if (typeof runtime.launchHeadless !== "function") {
    throw new RuntimeDoesNotSupportTasksError(runtime.kind);
  }
  return runtime;
}

interface RunDispatchArgs {
  readonly id: string;
  readonly workdir: string;
  readonly agentName: string;
  readonly brief: string;
  readonly details: string | undefined;
  readonly origin: TaskOrigin;
  readonly runtime: Runtime;
  readonly resolveResult: AgentResolveResult;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Inner dispatch flow: persists the initial task row, materialises
 * `TASK.md` + `temp/` + `artifact/`, asks the runtime to spawn the
 * subprocess, folds the runtime-supplied session id into metadata,
 * and wires the post-exit watcher that classifies the terminal
 * status via `decideTerminal` and persists it via `applyTerminal`.
 *
 * Caller (`dispatchTask`) is responsible for resolving the agent,
 * picking the runtime, reserving the workdir, and tracking the id
 * in `ctx.dispatchInProgress`. Pre-spawn failures roll back the
 * workdir entirely; post-spawn failures keep the row + workdir but
 * mark the task failed via the exit watcher.
 */
export async function runDispatch(ctx: TaskServiceCtx, args: RunDispatchArgs): Promise<TaskEntity> {
  const { id, workdir, agentName, brief, details, origin, runtime, resolveResult } = args;
  // Re-narrow `runtime.launchHeadless` for TypeScript across the
  // function boundary. We deliberately do NOT extract it to a local
  // because that would break the `this`-binding for runtime impls
  // that read own state (e.g. the `RealSpawnRuntime` test fixture).
  if (typeof runtime.launchHeadless !== "function") {
    throw new RuntimeDoesNotSupportTasksError(runtime.kind);
  }

  // 4. Persist the initial TaskEntity. Status is `running` from
  //    create time (v4 dropped the `not_started` placeholder). Any
  //    failure below rolls back the workdir — pre-spawn errors must
  //    not leave a ghost row on disk.
  //
  //    Spread order matters: caller-supplied `metadata` first, kernel
  //    keys (workdir, runtime) override. Lets schedulers tag a task
  //    at dispatch time without spoofing the runtime column
  //    (`task-repository.ts` promotes `metadata.runtime` to a
  //    first-class indexed column and folds it back on read —
  //    divergence would mislead the runtime filter / dashboard).
  const createdAt = ctx.now().toISOString();
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
    await ctx.repository.save(initial);
  } catch (err) {
    await safeRm(workdir, ctx.logger);
    throw err;
  }

  // 4b. Materialise the user's brief to `<workdir>/TASK.md` plus
  //     the agent-managed `temp/` + `artifact/` subdirs. The body
  //     lives in a file rather than the spawn argv (issue #109 —
  //     cmd.exe argv-LF interaction silently dropped copilot CLI
  //     flags on Windows). Pre-spawn rollback on failure.
  try {
    await writeFile(path.join(workdir, TASK_FILENAME), formatTaskMd(brief, details), {
      encoding: "utf8",
    });
    await mkdir(path.join(workdir, TASK_TEMP_SUBDIR), { recursive: true });
    await mkdir(path.join(workdir, TASK_ARTIFACT_SUBDIR), { recursive: true });
  } catch (err) {
    await safeRm(workdir, ctx.logger);
    throw err;
  }

  // 5. Spawn. The runtime owns the subprocess and returns a handle.
  //    Pre-running failures (provision throws, spawn ENOENT) roll
  //    back the workdir.
  let handle: RuntimeHandle;
  try {
    handle = await runtime.launchHeadless({
      workdir,
      agent: resolveResult,
      catalog: ctx.catalog,
      // Fixed single-line ASCII framing prompt. `brief` + `details`
      // are NOT passed via argv — they live byte-for-byte in
      // `<workdir>/TASK.md` and the framing prompt tells the agent
      // to read it. Today `copilot` is the only headless-capable
      // runtime; when a second arrives, switch on `runtime.kind`.
      prompt: TASK_FRAMING_PROMPT_COPILOT,
      workspaceDir: ctx.workspaceDir,
      // Per-task work-context env. The runtime layers its own
      // cross-cutting env (EMPLOKE_SERVER, EMPLOKE_SHARED_DIR, ...)
      // underneath via its `subprocessEnvBase` config.
      subprocessEnv: {
        EMPLOKE_WORKSPACE: ctx.workspaceId,
        EMPLOKE_WORKSPACE_DIR: ctx.workspaceDir,
        EMPLOKE_WORK_KIND: "task",
        EMPLOKE_WORK_ID: id,
        EMPLOKE_WORK_DIR: workdir,
      },
    });
  } catch (err) {
    await safeRm(workdir, ctx.logger);
    throw err;
  }

  // 5b. Re-check `shuttingDown` after spawn. The flag is read at the
  //     top of `dispatch()`, but `await runtime.launchHeadless(...)`
  //     yields the event loop and a SIGTERM-driven `shutdown()`
  //     could have flipped it. Without this guard the subprocess is
  //     live but `shutdown()`'s snapshot of `ctx.live` would miss
  //     it — the server would `process.exit(0)` and orphan it.
  if (ctx.shuttingDown) {
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
    await safeRm(workdir, ctx.logger);
    throw new ManagerShuttingDownError();
  }

  // 6. Fold runtime-session id into metadata. Status is already
  //    `running` from create-time, so no separate state transition.
  //    Persistence failure here is NOT rolled back (subprocess is
  //    live; orphan recovery handles it on next boot).
  let running: TaskEntity = initial;
  if (handle.runtimeSessionId !== undefined) {
    running = initial.withMetadata({
      ...initial.metadata,
      runtimeSessionId: handle.runtimeSessionId,
    });
    await ctx.repository.save(running);
  }

  // 7. Wire post-spawn background work: watch exit + persist
  //    terminal status. Order matters: register the `LiveTask` BEFORE
  //    awaiting anything so a `shutdown()` arriving during this
  //    window sees the entry in `ctx.live` and routes through the
  //    kill+drain path. The IIFE closes over `liveEntry` so it can
  //    read `killReason` AT exit time — a clean self-exit racing
  //    with shutdown still classifies as `success` if the kill flag
  //    hadn't flipped yet.
  const liveEntry: LiveTask = {
    id,
    handle,
    killReason: null,
    // `settled` is filled in just below; we need the object
    // reference first so the IIFE can close over it.
    settled: undefined as unknown as Promise<void>,
  };
  const settled = (async () => {
    let exitInfo: Awaited<RuntimeHandle["exit"]>;
    try {
      exitInfo = await handle.exit;
    } catch (err) {
      // Should not happen — handle.exit is built from child events
      // that resolve, never reject. Classify as `internal` so the
      // failure wire shape carries a typed kind operators can branch on.
      await applyTerminal(ctx, workdir, running, {
        kind: "failed",
        failure: {
          kind: "internal",
          message: `exit watcher rejected: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      ctx.live.delete(id);
      return;
    }

    // Read killReason AT exit time. A task that self-exited cleanly
    // with `code: 0` while `shutdown()` was running but had not yet
    // invoked `kill()` for this task still reads `null` here and
    // records `success`.
    const decision = decideTerminal(exitInfo, liveEntry.killReason);
    await applyTerminal(ctx, workdir, running, decision);
    ctx.live.delete(id);
  })();
  (liveEntry as { settled: Promise<void> }).settled = settled;

  ctx.live.set(id, liveEntry);

  return running;
}
