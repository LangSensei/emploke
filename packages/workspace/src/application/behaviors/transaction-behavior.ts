import { inject, injectable } from "inversify";
import { type PipelineBehavior, pipelineBehavior, type RequestData } from "mediatr-ts";
import { WorkspaceContext } from "../../infrastructure/workspace-context.js";

const pipelineBehaviorDecorator = pipelineBehavior() as ClassDecorator;

/**
 * Mediator pipeline behaviour that wraps every command in
 * em.transactional. Owned by @emploke/workspace per ADR-4
 * (per-bounded-context EM). Domain-event dispatch happens via
 * DomainEventDispatcher (MikroORM beforeFlush subscriber registered
 * in bootstrap), so this behaviour stays single-purpose:
 * BEGIN / COMMIT / ROLLBACK only. em.transactional auto-flushes at
 * the end of the callback, which triggers the subscriber's
 * beforeFlush hook (events dispatched, then SQL writes).
 */
@injectable()
export class TransactionBehavior implements PipelineBehavior {
  constructor(@inject(WorkspaceContext) private readonly ctx: WorkspaceContext) {}

  async handle(_request: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    return this.ctx.em.transactional(() => next());
  }
}

pipelineBehaviorDecorator(TransactionBehavior);
