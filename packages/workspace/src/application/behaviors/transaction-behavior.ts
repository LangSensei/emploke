import { inject, injectable } from "inversify";
import { type PipelineBehavior, pipelineBehavior, type RequestData } from "mediatr-ts";
import { runWithAfterCommitQueue, UnitOfWork } from "../unit-of-work.js";

const pipelineBehaviorDecorator = pipelineBehavior() as ClassDecorator;

/**
 * Mediator pipeline behaviour that wraps every command in
 * em.transactional **plus** drains a per-command after-commit queue
 * once the transaction successfully commits.
 *
 * ## Per-BC dispatch via inversify resolver
 *
 * `pipelineBehavior()` registers this CLASS on mediatr-ts's module
 * singleton. Each `Mediator` instance has its OWN inversify resolver,
 * and resolves `TransactionBehavior` against its own container per
 * `send()`. The `@inject(UnitOfWork)` annotation therefore resolves
 * to whatever `UnitOfWork` is bound in THAT mediator's container:
 *
 *   - root container: workspace pkg's `WorkspaceContext` (global.db EM)
 *   - per-workspace child container: per-workspace context (workspace.db EM)
 *
 * One behavior class, two contexts. No per-BC duplication.
 *
 * ## After-commit queue
 *
 * Inside {@link runWithAfterCommitQueue} an AsyncLocalStorage slot
 * holds a fresh queue for the lifetime of one command. Handler code
 * calls `uow.enqueueAfterCommit(fn)` to schedule a callback (typical
 * use: spawn a subprocess after the persistence transaction commits,
 * so a rolled-back commit cannot leak the side-effect). The queue
 * drains AFTER `em.transactional(...)` resolves successfully — a
 * throw from the transactional body bypasses the drain entirely.
 *
 * ## Pipeline order
 *
 * Must register AFTER ValidationBehavior so mediatr-ts puts it inner
 * in the pipeline. Logging wraps both. See workspace.di.test.ts for
 * the order-asserting unit test that catches accidental import
 * re-ordering.
 *
 * ## Domain-event dispatch
 *
 * Domain-event dispatch happens via `DomainEventDispatcher` (a
 * MikroORM `beforeFlush` subscriber registered in bootstrap), so this
 * behaviour stays single-purpose: BEGIN / COMMIT / ROLLBACK +
 * after-commit drain. `em.transactional` auto-flushes at the end of
 * the callback, which fires the subscriber's `beforeFlush` hook
 * (events dispatched, then SQL writes).
 */
@injectable()
export class TransactionBehavior implements PipelineBehavior {
  constructor(@inject(UnitOfWork) private readonly uow: UnitOfWork) {}

  async handle(_request: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    return runWithAfterCommitQueue(async (queue) => {
      const result = await this.uow.em.transactional(() => next());
      await queue.drain();
      return result;
    });
  }
}

pipelineBehaviorDecorator(TransactionBehavior);
