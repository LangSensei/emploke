import { inject, injectable } from "inversify";
import { type PipelineBehavior, pipelineBehavior, type RequestData } from "mediatr-ts";
import { runWithAfterCommitQueue } from "../after-commit-queue.js";
import { WorkspaceContext } from "../../infrastructure/workspace-context.js";

const pipelineBehaviorDecorator = pipelineBehavior() as ClassDecorator;

/**
 * Workspace pkg's transaction wrapper. Wraps every command sent
 * through the workspace pkg's Mediator in `em.transactional` and
 * drains the after-commit queue once the transaction commits
 * successfully.
 *
 * ## Per-BC behavior (design A)
 *
 * Each bounded context owns its OWN TransactionBehavior class bound
 * to its OWN EM. Workspace pkg's lives here (injects WorkspaceContext
 * → global.db EM). Session / task / catalog each define an analogous
 * class injecting their respective contexts. No abstract UnitOfWork,
 * no per-Mediator token-override gymnastics — each BC's compose
 * function constructs its own Mediator and registers ONLY that BC's
 * behaviors (via the `@pipelineBehavior` decorator side-effect at its
 * own module import, which the BC's compose function controls).
 *
 * ## Domain-event dispatch
 *
 * Domain events fire via `DomainEventDispatcher` (a MikroORM
 * `beforeFlush` subscriber registered in `composeWorkspaceModule`),
 * so this behavior stays single-purpose: BEGIN / COMMIT / ROLLBACK +
 * after-commit drain. `em.transactional` auto-flushes at the end of
 * the callback, firing the subscriber's hook (events dispatched,
 * then SQL writes hit SQLite — all atomic).
 *
 * ## After-commit queue
 *
 * The queue is opened via {@link runWithAfterCommitQueue} for the
 * lifetime of one command. Handlers (and anything reachable from
 * them) call `enqueueAfterCommit(fn)` from `@emploke/workspace` to
 * stage callbacks. Drained AFTER `em.transactional` resolves
 * successfully — a throw inside the transactional body discards the
 * queue.
 */
@injectable()
export class TransactionBehavior implements PipelineBehavior {
  constructor(@inject(WorkspaceContext) private readonly ctx: WorkspaceContext) {}

  async handle(_request: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    return runWithAfterCommitQueue(async (queue) => {
      const result = await this.ctx.em.transactional(() => next());
      await queue.drain();
      return result;
    });
  }
}

pipelineBehaviorDecorator(TransactionBehavior);
