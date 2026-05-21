import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Generic "do this after the transaction commits" helper, usable by
 * any bounded context whose TransactionBehavior wants to defer
 * side-effects (subprocess spawn, file IO, external API calls) until
 * the persistence transaction has actually committed.
 *
 * ## Why module-level + AsyncLocalStorage
 *
 * Each BC owns its own ORM / EntityManager / Mediator under design A
 * (per-BC ORM, per-BC Mediator). But the queue logic — "buffer
 * callbacks during the request, drain them after the transaction
 * commits, discard them if it rolls back" — is identical for every
 * BC. Living in `@emploke/workspace` (the shared DDD seedwork pkg)
 * + scoped through AsyncLocalStorage means:
 *
 *   - any BC's TransactionBehavior opens a queue via {@link runWithAfterCommitQueue}
 *     for the lifetime of one command, drains it after the inner
 *     em.transactional resolves, abandons it on throw
 *   - any handler / domain code under that async context can call
 *     {@link enqueueAfterCommit} to stage a callback
 *   - concurrent commands (even across BCs) get independent queues
 *     because AsyncLocalStorage stores the queue per execution context
 *
 * ## Outside-of-transaction behaviour
 *
 * Test helpers that drive a handler outside of any TransactionBehavior
 * have no queue on the stack. {@link enqueueAfterCommit} runs the
 * callback INLINE in that case (deferred to a microtask via
 * `Promise.resolve().then`). This keeps production code paths simple —
 * handlers can call `enqueueAfterCommit(...)` unconditionally — at the
 * cost of test code seeing a slightly different ordering than prod.
 * Tests that need strict ordering must drive through a real
 * TransactionBehavior (or the BC's compose function).
 */

export type AfterCommitCallback = () => void | Promise<void>;

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
 * Open an after-commit queue for the lifetime of `work`. Typical
 * call shape from a BC's TransactionBehavior:
 *
 * ```ts
 * return runWithAfterCommitQueue(async (queue) => {
 *   const result = await this.em.transactional(() => next());
 *   await queue.drain();
 *   return result;
 * });
 * ```
 */
export async function runWithAfterCommitQueue<T>(
  work: (queue: AfterCommitQueue) => Promise<T>,
): Promise<T> {
  const queue = makeQueue();
  return queueStorage.run(queue, () => work(queue));
}

/**
 * Stage `callback` to run after the current transaction commits.
 *
 * If no transactional scope is active (e.g. a unit test driving a
 * handler directly), the callback is scheduled to run on the next
 * microtask instead.
 */
export function enqueueAfterCommit(callback: AfterCommitCallback): void {
  const queue = queueStorage.getStore();
  if (queue) {
    queue.push(callback);
    return;
  }
  void Promise.resolve().then(callback);
}
