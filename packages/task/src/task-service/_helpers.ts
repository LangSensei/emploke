/**
 * Shared utilities for the task-service SPLIT sub-layout. Sibling
 * concern files (`dispatch.ts`, `mutations.ts`, `agent-resolver.ts`,
 * `queries.ts`, `activity-stream.ts`, `shutdown.ts`) all compose
 * through the facade and pull cross-cutting helpers from here, so no
 * sibling-to-sibling import edges remain. Leading underscore marks
 * this file as private utility (NOT a SPLIT peer) per the
 * pkg-template convention.
 */

import { rm } from "node:fs/promises";
import type { Runtime, RuntimeHandle } from "@emploke/runtime";
import type { Logger } from "pino";
import { TASK_ARTIFACT_SUBDIR } from "../framing.js";
import type { TaskEntity } from "../task-entity.js";
import { pickRuntimeSessionId, type TaskServiceCtx } from "../task-service.js";
import type { TaskCancellation, TaskFailure } from "../types.js";
import { listWorkdirFiles } from "../workdir.js";

/**
 * Maximum chars retained from the agent's final assistant utterance
 * into `TaskSuccess.output`. Caps the persisted row size; the full
 * text is preserved in the runtime's activity log. Truncated from the
 * **head** (`slice(0, MAX)`) so the leading bytes — typically a PR
 * URL or headline — are always preserved.
 */
const TASK_OUTPUT_MAX_CHARS = 8000;

/**
 * In-memory record for a task whose subprocess this manager still
 * owns. Dropped from {@link TaskServiceCtx.live} once the subprocess
 * exits and the post-exit fs writes complete.
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
 * `cancel(id)` calls coordinate via the `wasFirstToCancel` check in
 * `cancelTask`: the first call owns the kill, every subsequent call
 * awaits `live.settled` and then throws `InvalidTransition`.
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
 * so {@link applyTerminal} can dispatch typed transitions to the
 * entity. `exit_code` / `signal` live strictly inside the `failure`
 * payload — they are not mirrored onto the task metadata bag.
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
 * Apply a terminal decision to a running task and persist. `exit_code`
 * / `signal` live strictly inside the `failure` payload (no metadata
 * mirror). Persistence failure is warn-logged but not rethrown — the
 * subprocess is already gone, so callers cannot do anything useful
 * with an error here.
 */
export async function applyTerminal(
  ctx: TaskServiceCtx,
  workdir: string,
  running: TaskEntity,
  decision: TerminalDecision,
): Promise<void> {
  let next: TaskEntity;
  try {
    switch (decision.kind) {
      case "succeeded": {
        // At terminal time collect the agent's last assistant
        // utterance and the `<workdir>/artifact/` listing for the
        // persisted `TaskSuccess` payload. Both sub-collectors are
        // best-effort and degrade to `null` / `[]` on failure.
        const [output, artifacts] = await collectSuccessPayload(ctx, workdir, running);
        next = running.complete({ output, artifacts }, { now: ctx.now().toISOString() });
        break;
      }
      case "failed":
        next = running.fail(decision.failure, { now: ctx.now().toISOString() });
        break;
      case "cancelled":
        next = running.cancel(decision.cancellation, { now: ctx.now().toISOString() });
        break;
    }
    await ctx.repository.save(next);
  } catch (err) {
    ctx.logger.warn({ taskId: running.id, err }, "tasks: failed to persist terminal status");
  }
}

/**
 * Best-effort assembly of the `TaskSuccess` payload at terminal time.
 * Asks the runtime for its last agent-produced activity (capped to
 * {@link TASK_OUTPUT_MAX_CHARS}, head preserved) and lists
 * `<workdir>/artifact/`. Both sub-collectors fan out in parallel;
 * any sub-failure degrades to `null` / `[]` and warns — never blocks
 * the terminal transition.
 */
async function collectSuccessPayload(
  ctx: TaskServiceCtx,
  workdir: string,
  task: TaskEntity,
): Promise<[string | null, readonly string[]]> {
  const runtimeName = task.metadata.runtime;
  const runtimeSessionId = pickRuntimeSessionId(task.metadata);

  const outputP: Promise<string | null> = (async () => {
    if (typeof runtimeName !== "string" || runtimeSessionId === null) return null;
    let runtime: Runtime;
    try {
      runtime = ctx.runtimeRegistry.get(runtimeName);
    } catch {
      return null;
    }
    if (typeof runtime.getLastAgentActivity !== "function") return null;
    try {
      const last = await runtime.getLastAgentActivity(runtimeSessionId);
      if (last === null) return null;
      // Head-preserving cap: a tail-preserving slice would silently
      // drop opening characters when the final reply exceeded MAX.
      return last.text.slice(0, TASK_OUTPUT_MAX_CHARS);
    } catch (err) {
      ctx.logger.warn(
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
      ctx.logger.warn(
        { taskId: task.id, err },
        "tasks: applyTerminal listWorkdirFiles failed; artifacts left empty",
      );
      return [];
    }
  })();

  return Promise.all([outputP, artifactsP]);
}
