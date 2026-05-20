import type { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { Clock } from "../domain/clock.js";
import { WorkspaceRepository } from "../domain/workspace-repository.js";
import { DomainEventSubscriber } from "../infrastructure/domain-event-subscriber.js";
import { MikroWorkspaceQueries } from "./queries/mikro-workspace-queries.js";
import { MikroWorkspaceRepository } from "../infrastructure/mikro-workspace-repository.js";
import { SystemClock } from "../infrastructure/system-clock.js";
import { RegisterWorkspaceCommand } from "./commands/register-workspace/register-workspace.command.js";
import { RegisterWorkspaceCommandHandler } from "./commands/register-workspace/register-workspace.command-handler.js";
import { RenameWorkspaceCommand } from "./commands/rename-workspace/rename-workspace.command.js";
import { RenameWorkspaceCommandHandler } from "./commands/rename-workspace/rename-workspace.command-handler.js";
import { SetCurrentWorkspaceCommand } from "./commands/set-current-workspace/set-current-workspace.command.js";
import { SetCurrentWorkspaceCommandHandler } from "./commands/set-current-workspace/set-current-workspace.command-handler.js";
import { UnregisterWorkspaceCommand } from "./commands/unregister-workspace/unregister-workspace.command.js";
import { UnregisterWorkspaceCommandHandler } from "./commands/unregister-workspace/unregister-workspace.command-handler.js";
import { WorkspaceQueries } from "./queries/workspace-queries.js";

/**
 * Register the `@emploke/workspace` package's bindings into the
 * inversify container, then wire its command handlers into the
 * mediator.
 *
 * ## Prerequisites (bound by the composition root BEFORE this is called)
 *
 *   - `Mediator` — the mediatr-ts dispatcher (`@inject(Mediator)`).
 *   - `EntityManager` — the global-scope MikroORM EM. The composition
 *     root opens `MikroORM.init({ entities: [Workspace], dbName:
 *     globalDbFile, … })` and binds `orm.em` as a constant. The
 *     repository / queries / register handler all inject this token.
 *     Post-Phase-2 / ADR-3: this REPLACES the previous `WorkspaceDb`
 *     `DatabaseSync` symbol.
 *
 * ## What this function binds
 *
 *   - `Clock` → `SystemClock` (singleton; no per-call state, so a
 *     shared instance is fine).
 *   - `WorkspaceRepository` → `MikroWorkspaceRepository` (singleton;
 *     wraps the singleton `EntityManager` so the same UoW is reused
 *     across handlers).
 *   - `WorkspaceQueries` → `MikroWorkspaceQueries` (singleton).
 *   - `DomainEventSubscriber` → self (singleton). The composition
 *     root is expected to PULL this binding out of the container and
 *     pass it into `MikroORM.init({ subscribers: [...] })` so events
 *     fire on every flush; binding it here keeps the dependency arrow
 *     pointing the right way (`@inject(Mediator)` requires the
 *     mediator to already be bound).
 *   - Every command handler `toSelf()` so the mediator's
 *     `InversifyResolver.resolve(HandlerClass)` succeeds.
 *
 * Then it manually registers each command-handler pair on the
 * mediator (per ADR #135 decision 6 — avoids the `@requestHandler`
 * decorator's "must import every handler at startup" footgun).
 *
 * ## Phase 2 caveat: still no notification handlers
 *
 * The 3 lifecycle events (`WorkspaceRegistered`, `WorkspaceRenamed`,
 * `WorkspaceUnregistered`) are raised by the aggregate and dispatched
 * via `DomainEventSubscriber.afterFlush` (NEW in Phase 2), but no
 * subscriber is registered. The subscriber swallows the
 * "no handler found" mediatr-ts error so the publish path stays
 * green; Phase 3+ adds cross-context subscribers without re-wiring.
 */
export function composeWorkspaceModule(container: Container): void {
  // Domain / application bindings
  container.bind(Clock).to(SystemClock).inSingletonScope();
  container.bind(WorkspaceRepository).to(MikroWorkspaceRepository).inSingletonScope();
  container.bind(WorkspaceQueries).to(MikroWorkspaceQueries).inSingletonScope();
  container.bind(DomainEventSubscriber).toSelf().inSingletonScope();

  // Handler bindings are intentionally NOT made `toSelf()` here.
  // The mediator's resolver (`InversifyResolver`) auto-binds each
  // handler class on `add()`, which mediatr-ts calls both at Mediator
  // construction (populating the resolver from `typeMappings`) and at
  // each `registerHandler(...)` call below. Explicit `toSelf` would
  // collide with that auto-bind and produce "Ambiguous bindings"
  // errors on the next test that builds a fresh container (since
  // `typeMappings` is a module-level singleton — see comment block
  // on `registerCommandIdempotent`).

  // Manual mediator registration (ADR #135 decision 6). The mediator
  // is already bound by the composition root, so `container.get` here
  // never throws.
  //
  // mediatr-ts stores handler mappings on a **module-level singleton**
  // (`typeMappings.requestHandlers`), not per-Mediator-instance. In
  // production this is fine because compose-modules run exactly once
  // per process. In tests that build multiple containers, however,
  // the second `composeWorkspaceModule` call would throw "defined
  // twice". The lib has no `unregister` API, so we make the
  // registration **idempotent**: if a request type is already mapped,
  // skip — the mapped handler is byte-identical to the one we'd
  // register anyway (the same class). Production runs hit the
  // happy-path on the first invocation; test runs hit the skip-path
  // on every subsequent file.
  const mediator = container.get(Mediator);
  registerCommandIdempotent(mediator, RegisterWorkspaceCommand, RegisterWorkspaceCommandHandler);
  registerCommandIdempotent(mediator, RenameWorkspaceCommand, RenameWorkspaceCommandHandler);
  registerCommandIdempotent(
    mediator,
    UnregisterWorkspaceCommand,
    UnregisterWorkspaceCommandHandler,
  );
  registerCommandIdempotent(
    mediator,
    SetCurrentWorkspaceCommand,
    SetCurrentWorkspaceCommandHandler,
  );
}

function registerCommandIdempotent(
  mediator: Mediator,
  // biome-ignore lint/suspicious/noExplicitAny: mediatr-ts requires the wide AnyHandlerClass shape — see the AnyHandlerClass alias above.
  command: any,
  // biome-ignore lint/suspicious/noExplicitAny: see above
  handler: any,
): void {
  try {
    mediator.registerHandler(command, handler);
  } catch (err) {
    // Already-registered errors are safe to swallow — see the comment
    // block in `composeWorkspaceModule` for why. Anything else (e.g. a
    // typo in the handler class) re-throws.
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("defined twice")) throw err;
  }
}
