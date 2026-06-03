import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedAgent, Runtime, RuntimeHandle } from "@emploke/runtime";
import { ManagerShuttingDownError } from "../errors.js";
import {
  formatTaskMd,
  TASK_ARTIFACT_SUBDIR,
  TASK_FILENAME,
  TASK_FRAMING_PROMPT_COPILOT,
  TASK_TEMP_SUBDIR,
} from "../framing.js";
import { TaskEntity } from "../task-entity.js";
import type { TaskServiceCtx } from "../task-service.js";
import type { TaskOrigin } from "../types.js";
import { applyTerminal, decideTerminal, type LiveTask, safeRm } from "./_helpers.js";

/**
 * `runtime` is narrowed to the subset on which `launchHeadless` is
 * guaranteed to exist. `pickRuntime` performs that narrowing once
 * (and throws `RuntimeDoesNotSupportTasksError` if the runtime is
 * registered but cannot launch tasks), so the dispatch flow can
 * dereference `runtime.launchHeadless` without a second defensive
 * check.
 */
export interface RunDispatchArgs {
  readonly id: string;
  readonly workdir: string;
  readonly agentName: string;
  readonly brief: string;
  readonly details: string | undefined;
  readonly origin: TaskOrigin;
  readonly runtime: Runtime & { launchHeadless: NonNullable<Runtime["launchHeadless"]> };
  readonly resolveResult: ResolvedAgent;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Inner dispatch flow: persists the initial task row, materialises
 * `TASK.md` + `temp/` + `artifact/`, asks the runtime to spawn the
 * subprocess, folds the runtime-supplied session id into metadata,
 * and wires the post-exit watcher that classifies the terminal
 * status via {@link decideTerminal} and persists it via
 * {@link applyTerminal}.
 *
 * Caller (`dispatchTask`) is responsible for resolving the agent,
 * picking the runtime, reserving the workdir, and tracking the id
 * in `ctx.dispatchInProgress`. Pre-spawn failures roll back the
 * workdir entirely; post-spawn failures keep the row + workdir but
 * mark the task failed via the exit watcher.
 */
export async function runDispatch(ctx: TaskServiceCtx, args: RunDispatchArgs): Promise<TaskEntity> {
  const { id, workdir, agentName, brief, details, origin, runtime, resolveResult } = args;

  // 4. Persist the initial TaskEntity. Status is `running` from
  //    create time — there is no intermediate non-terminal state.
  //    Any failure below rolls back the workdir; pre-spawn errors
  //    must not leave a ghost row on disk.
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
  //     lives in a file rather than the spawn argv because on
  //     Windows `cmd.exe` treats LF inside a `/c` payload as a
  //     statement separator, silently dropping copilot CLI flags
  //     that follow a user-supplied LF. Pre-spawn rollback on
  //     failure.
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
      catalog: ctx.contentSource,
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
