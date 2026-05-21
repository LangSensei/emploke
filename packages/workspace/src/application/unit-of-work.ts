import type { SqlEntityManager } from "@mikro-orm/better-sqlite";
import type { EntityManager } from "@mikro-orm/core";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Bounded-context persistence handle — the eShop "DbContext" analog
 * generalised across every emploke bounded context.
 *
 * A `UnitOfWork` exposes the MikroORM `EntityManager` for one BC's
 * unit-of-work and an `enqueueAfterCommit` hook so handlers can stage
 * side-effects (subprocess spawn, file IO, external API call) that
 * must NOT run inside the transaction. The queue drains AFTER
 * `em.transactional(...)` resolves successfully; a rolled-back
 * transaction silently discards staged callbacks.
 *
 * ## Multiple BC contexts in one process
 *
 * The root inversify container binds `UnitOfWork` to the workspace
 * pkg's global-registry context (global.db). Per-workspace child
 * containers OVERRIDE the binding with a per-workspace context
 * (workspace.db, shared by session/task/catalog). One generic
 * `TransactionBehavior` injects `UnitOfWork` and picks up the right
 * one because mediatr-ts uses each Mediator's own inversify resolver
 * to materialise its behaviors.
 *
 * ## AfterCommit semantics
 *
 * `enqueueAfterCommit(fn)` may be called any time during a command
 * handler (or any handler / behavior on the pipeline). The queue is
 * scoped per `em.transactional(...)` call via
 * `AsyncLocalStorage` — concurrent commands on the same EM get
 * independent queues. Callbacks run in FIFO order, sequentially
 * (await-each), AFTER the transaction commits. A throwing callback
 * does NOT roll back the already-committed transaction; it surfaces
 * to the caller of `mediator.send(...)` so the route handler can map
 * it (or fail loudly in tests).
 *
 * Outside a transactional scope (no active queue), calling
 * `enqueueAfterCommit` runs the callback IMMEDIATELY (await). This
 * keeps test helpers that bypass the pipeline simple while still
 * making the production code path explicit.
 */
export abstract class UnitOfWork {
  /** The active EntityManager for this BC's unit of work. */
  abstract get em(): EntityManager;

  /** Cast to the better-sqlite-flavoured EM (for raw query escape hatches). */
  abstract get sqlEm(): SqlEntityManager;

  /**
   * Stage `callback` to run after the current transaction commits.
   * No-op rollback semantics (see class jsdoc).
   */
  abstract enqueueAfterCommit(callback: AfterCommitCallback): void;
}

/**
 * After-commit callback. Returns a `Promise<void>` or `void`; the
 * drain loop awaits each one sequentially in FIFO order.
 */
export type AfterCommitCallback = () => void | Promise<void>;

/**
 * Internal queue type held by the `AsyncLocalStorage` slot. Exported
 * for the {@link runWithAfterCommitQueue} helper that
 * `TransactionBehavior` (and bounded-context test helpers) call.
 */
export interface AfterCommitQueue {
  push(cb: AfterCommitCallback): void;
  drain(): Promise<void>;
}

const queueStorage = new AsyncLocalStorage<AfterCommitQueue>();

function makeQueue(): AfterCommitQueue {
  const list: AfterCommitCallback[] = [];
  return {
    push(cb) {
      list.push(cb);
    },
    async drain() {
      for (const cb of list) {
        await cb();
      }
      list.length = 0;
    },
  };
}

/**
 * Open an after-commit queue for the lifetime of `work`. Used by
 * `TransactionBehavior`:
 *
 * ```ts
 * await runWithAfterCommitQueue(async (queue) => {
 *   await uow.em.transactional(() => next());
 *   await queue.drain();
 * });
 * ```
 *
 * The queue is bound to AsyncLocalStorage so anything `await`-reachable
 * from `work` can call {@link currentAfterCommitQueue} to enqueue.
 */
export async function runWithAfterCommitQueue<T>(
  work: (queue: AfterCommitQueue) => Promise<T>,
): Promise<T> {
  const queue = makeQueue();
  return queueStorage.run(queue, () => work(queue));
}

/**
 * Returns the active after-commit queue, or `null` when no
 * transaction is on the stack. Used by `UnitOfWork.enqueueAfterCommit`
 * implementations.
 */
export function currentAfterCommitQueue(): AfterCommitQueue | null {
  return queueStorage.getStore() ?? null;
}
