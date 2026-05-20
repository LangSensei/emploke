import { inject, injectable } from "inversify";
import { type PipelineBehavior, pipelineBehavior, type RequestData } from "mediatr-ts";
import { WorkspaceContext } from "../../infrastructure/workspace-context.js";

// mediatr-ts ships the pipelineBehavior decorator typed as
// `() => (target: Function) => void`, which TypeScript 5.x with
// `experimentalDecorators` rejects (TS1206 — class decorators must
// return TFunction | void). The cast through `ClassDecorator` keeps
// the runtime behaviour intact while satisfying the compiler.
const pipelineBehaviorDecorator = pipelineBehavior() as ClassDecorator;

/**
 * Mediator pipeline behaviour that wraps every command/notification
 * in `em.transactional(...)`.
 *
 * Phase 2 / ADR-3: every command handler runs inside this scope, so
 * the handler can mutate aggregates without a per-handler
 * `repo.save()` call — the surrounding `em.flush` (triggered by the
 * end of the `em.transactional` callback) writes every change-set in
 * one transaction, then fires the `afterFlush` events that
 * `DomainEventSubscriber` listens for.
 *
 * ## Flow on success
 *
 *  1. mediator dispatches `XxxCommand`
 *  2. **this behaviour** opens a transaction (`BEGIN`) on the
 *     EntityManager's connection
 *  3. command handler executes; mutates entities via persist / remove /
 *     tracked-instance setters
 *  4. handler returns → `em.flush()` writes every INSERT/UPDATE/DELETE
 *  5. `afterFlush` event fires → `DomainEventSubscriber.afterFlush`
 *     walks the change-set and `mediator.publish(...)` each accumulated
 *     domain event
 *  6. `em.transactional` commits → SQL becomes durable
 *  7. behaviour returns the handler's result to the caller
 *
 * ## Flow on error
 *
 * If the handler throws OR a subscriber throws OR `em.flush` itself
 * throws (e.g. constraint violation), `em.transactional` rolls back.
 * The SQL writes never commit AND the published events never become
 * "real" — the event handler may have side-effected (write to disk,
 * call an external service) but the database state is unchanged.
 * For Phase 2 the publish path is in-process only (no outbox), so
 * this is acceptable; integration events that need crash safety
 * land in Phase 7 with the transactional-outbox pattern.
 *
 * ## Registration
 *
 * mediatr-ts ships `@pipelineBehavior()` as a class decorator whose
 * runtime type (`() => (target: Function) => void`) trips
 * TypeScript 5.x's stricter experimentalDecorators check (TS1206).
 * The {@link registerTransactionBehavior} export below applies the
 * decorator at module-load time via the runtime form; the server's
 * bootstrap imports this file once, which is enough to enroll the
 * behaviour on the mediatr-ts module-level singleton.
 *
 * ## Why this lives in `@emploke/workspace` (per ADR-4)

 *
 * `TransactionBehavior` wraps the workspace context's `EntityManager`.
 * Under ADR-4 (per-bounded-context EM, issue #141), each bounded
 * context owns its OWN MikroORM instance and its OWN TransactionBehavior
 * wrapping it. Phase 3+ adds analogous behaviours in `@emploke/session`,
 * `@emploke/task`, `@emploke/catalog` — each bound to that context's
 * EM token (`SESSION_EM`, `TASK_EM`, ...).
 *
 * The server pkg is purely a composition root: it imports
 * `composeWorkspaceModule` (which transitively loads THIS file),
 * triggering the module-level `pipelineBehaviorDecorator` call below
 * to enroll the behaviour on mediatr-ts's singleton registry. Server
 * does not own this code — that would force every context's behaviour
 * to live in a non-context pkg, violating DDD context autonomy.
 */
@injectable()
export class TransactionBehavior implements PipelineBehavior {
  constructor(@inject(WorkspaceContext) private readonly ctx: WorkspaceContext) {}

  async handle(_request: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    // `em.transactional` (a) forks the EM so the inner handler sees
    // a request-scoped identity map, (b) opens a transaction on the
    // fork's connection, (c) calls `em.flush` at the end of the
    // callback (which fires `afterFlush` subscribers), and (d)
    // commits / rolls back as appropriate. The handler injects
    // `EntityManager` and gets the global EM, but operations on it
    // are routed through the forked context for the duration of
    // this call thanks to MikroORM's AsyncLocalStorage-based
    // `RequestContext`.
    return this.ctx.em.transactional(async () => {
      return await next();
    });
  }
}

// Apply the mediatr-ts `@pipelineBehavior()` decorator at module load.
// Equivalent to writing `@pipelineBehavior()` on the class above, but
// avoids TS1206 ("Decorators are not valid here") that
// experimentalDecorators raises against mediatr-ts's loose `Function`
// return type. Fires exactly once per process thanks to ESM module
// caching.
pipelineBehaviorDecorator(TransactionBehavior);
