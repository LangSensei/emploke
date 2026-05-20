import { inject, injectable } from "inversify";
import { type PipelineBehavior, pipelineBehavior, type RequestData } from "mediatr-ts";
import { WorkspaceContext } from "../../infrastructure/workspace-context.js";

const pipelineBehaviorDecorator = pipelineBehavior() as ClassDecorator;

/**
 * Mediator pipeline behaviour that wraps every command in
 * em.transactional and routes the commit through
 * WorkspaceContext.saveEntities(). Owned by @emploke/workspace per
 * ADR-4 (per-bounded-context EM). Phase 3+ adds analogous behaviours
 * inside session/task/catalog pkgs each bound to their own context.
 *
 * Flow:
 *  1. em.transactional opens BEGIN
 *  2. command handler runs
 *  3. ctx.saveEntities dispatches events then flushes change-set
 *  4. transactional COMMITs on clean return; throw rolls back
 */
@injectable()
export class TransactionBehavior implements PipelineBehavior {
  constructor(@inject(WorkspaceContext) private readonly ctx: WorkspaceContext) {}

  async handle(_request: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    return this.ctx.em.transactional(async () => {
      const result = await next();
      await this.ctx.saveEntities();
      return result;
    });
  }
}

pipelineBehaviorDecorator(TransactionBehavior);
