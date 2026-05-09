import { InvalidTransition } from "./errors.js";
import type { Task, TaskEvent } from "./types.js";

/**
 * Apply a state-transition event to a task. Pure: returns a new task
 * value; the input is not mutated.
 *
 * Throws {@link InvalidTransition} when the event is not legal in the
 * task's current status. Legal transitions:
 *
 *   not_started ──start────► running
 *   running     ──complete─► success
 *   running     ──fail─────► failure
 *   running     ──cancel───► cancelled
 *
 * Terminal statuses (`success` / `failure` / `cancelled`) accept no
 * further events.
 *
 * Metadata semantics: every event accepts an optional `metadata` patch
 * that is shallow-merged into the task's existing metadata. Last write
 * wins per key. There is no delete operation — the task is a history
 * accumulator, not a mutable record.
 */
export function apply(task: Task, event: TaskEvent, now: string = new Date().toISOString()): Task {
  switch (event.type) {
    case "start": {
      if (task.status !== "not_started") {
        throw new InvalidTransition(task.status, event.type);
      }
      return {
        ...task,
        status: "running",
        startedAt: now,
        metadata: mergeMetadata(task.metadata, event.metadata),
      };
    }
    case "complete": {
      if (task.status !== "running") {
        throw new InvalidTransition(task.status, event.type);
      }
      return {
        ...task,
        status: "success",
        endedAt: now,
        result: { output: event.output },
        metadata: mergeMetadata(task.metadata, event.metadata),
      };
    }
    case "fail": {
      if (task.status !== "running") {
        throw new InvalidTransition(task.status, event.type);
      }
      return {
        ...task,
        status: "failure",
        endedAt: now,
        failure: { error: event.error },
        metadata: mergeMetadata(task.metadata, event.metadata),
      };
    }
    case "cancel": {
      // cancel is legal from both not_started and running. (Pre-flight
      // failures — e.g. provisioner can't write to disk — should be
      // reportable without first moving the task to "running".)
      //
      // Currently no caller in the emploke runtime/server emits this
      // event — `TaskManager.delete()` ends up recording `failure`
      // (typically "terminated by signal SIGTERM" via the exit watcher,
      // before the workdir is removed), and `shutdown()` records
      // `failure` with reason "server shutdown". `cancel` is reserved
      // for a future user-cancel API; the FSM exposes the transition so
      // that API can be added without changing this file or the
      // persisted schema. See the note on `TaskStatus` in ./types.ts.
      if (task.status !== "not_started" && task.status !== "running") {
        throw new InvalidTransition(task.status, event.type);
      }
      return {
        ...task,
        status: "cancelled",
        endedAt: now,
        metadata: mergeMetadata(task.metadata, event.metadata),
      };
    }
    default: {
      // Exhaustiveness guard — TS compiler will flag missing variants.
      const _exhaustive: never = event;
      throw new Error(`unhandled event type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function mergeMetadata(
  base: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (patch === undefined) return base;
  return { ...base, ...patch };
}
