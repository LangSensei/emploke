import type { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { Clock } from "../domain/clock.js";
import { WorkspaceRepository } from "../domain/workspace-repository.js";
import { SqliteWorkspaceQueries } from "../infrastructure/sqlite-workspace-queries.js";
import { SqliteWorkspaceRepository } from "../infrastructure/sqlite-workspace-repository.js";
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
 *   - `WorkspaceDb` — the `DatabaseSync` handle for the workspace
 *     pkg's storage (= `<EMPLOKE_HOME>/global.db` in production).
 *     See `infrastructure/workspace-db.ts`. The composition root
 *     binds this as a constant after running
 *     `runPkgMigrations(globalDb, [{ pkg: 'workspace', migrations: WORKSPACE_MIGRATIONS }])`,
 *     so `SqliteWorkspaceRepository`'s schema-version assertion
 *     passes the first time it's resolved.
 *
 * ## What this function binds
 *
 *   - `Clock` → `SystemClock` (singleton; cheap factory but no
 *     per-call state, so a shared instance is fine).
 *   - `WorkspaceRepository` → `SqliteWorkspaceRepository` (singleton;
 *     wraps the singleton `WorkspaceDb` so the same connection is
 *     reused across handlers).
 *   - `WorkspaceQueries` → `SqliteWorkspaceQueries` (singleton).
 *   - Every command handler `toSelf()` so the mediator's
 *     `InversifyResolver.resolve(HandlerClass)` succeeds.
 *
 * Then it manually registers each command-handler pair on the
 * mediator (per ADR #135 decision 6 — avoids the `@requestHandler`
 * decorator's "must import every handler at startup" footgun).
 *
 * ## Phase 1 caveat: no notification handlers yet
 *
 * The 3 lifecycle events (`WorkspaceRegistered`, `WorkspaceRenamed`,
 * `WorkspaceUnregistered`) are raised by the aggregate and dispatched
 * via `mediator.publish(...)`, but no subscriber is registered.
 * That's intentional: workspace is the root context with no
 * upstream-context reactions. The dispatch path is exercised end-to-end
 * (test pulls + publishes against a real mediator) so Phase 3+ can add
 * cross-context subscribers without re-litigating the wiring.
 */
export function composeWorkspaceModule(container: Container): void {
  // Domain / application bindings
  container.bind(Clock).to(SystemClock).inSingletonScope();
  container.bind(WorkspaceRepository).to(SqliteWorkspaceRepository).inSingletonScope();
  container.bind(WorkspaceQueries).to(SqliteWorkspaceQueries).inSingletonScope();

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
