import type { Container } from "inversify";
import { Mediator, notificationHandler } from "mediatr-ts";
import { WorkspaceUnregistered } from "../domain/aggregates/workspace/events/workspace-unregistered.js";
import { WorkspaceRepository } from "../domain/aggregates/workspace/workspace-repository.js";
import { Clock } from "../domain/clock.js";
import { DomainEventDispatcher } from "../infrastructure/domain-event-dispatcher.js";
import { MikroWorkspaceRepository } from "../infrastructure/repositories/mikro-workspace-repository.js";
import { SystemClock } from "../infrastructure/system-clock.js";
import { WorkspaceContext } from "../infrastructure/workspace-context.js";
import { RegisterWorkspaceCommand } from "./commands/register-workspace.command.js";
import { RegisterWorkspaceCommandHandler } from "./commands/register-workspace.command-handler.js";
import { RenameWorkspaceCommand } from "./commands/rename-workspace.command.js";
import { RenameWorkspaceCommandHandler } from "./commands/rename-workspace.command-handler.js";
import { SetCurrentWorkspaceCommand } from "./commands/set-current-workspace.command.js";
import { SetCurrentWorkspaceCommandHandler } from "./commands/set-current-workspace.command-handler.js";
import { UnregisterWorkspaceCommand } from "./commands/unregister-workspace.command.js";
import { UnregisterWorkspaceCommandHandler } from "./commands/unregister-workspace.command-handler.js";
import { ClearCurrentOnUnregisterHandler } from "./domain-event-handlers/clear-current-on-unregister.handler.js";
import { MikroWorkspaceQueries } from "./queries/mikro-workspace-queries.js";
import { WorkspaceQueries } from "./queries/workspace-queries.js";
import { CommandValidatorRegistry } from "./validations/command-validator-registry.js";
import { RegisterWorkspaceCommandValidator } from "./validations/register-workspace.validator.js";
import { RenameWorkspaceCommandValidator } from "./validations/rename-workspace.validator.js";
import { SetCurrentWorkspaceCommandValidator } from "./validations/set-current-workspace.validator.js";
import { UnregisterWorkspaceCommandValidator } from "./validations/unregister-workspace.validator.js";

// Register notification handlers with mediatr-ts module-level mappings
// at module load via decorator side-effect.
notificationHandler(WorkspaceUnregistered)(ClearCurrentOnUnregisterHandler);

/**
 * Register the @emploke/workspace package's bindings into the
 * inversify container, then wire its command + notification handlers
 * into the mediator.
 *
 * ## Prerequisites
 *   - Mediator and EntityManager must be bound before this is called.
 *
 * ## What this function binds
 *   - WorkspaceContext, WorkspaceRepository, WorkspaceQueries,
 *     DomainEventDispatcher, Clock (singletons)
 *   - CommandValidatorRegistry (singleton; populated with one validator
 *     per command class)
 *   - ClearCurrentOnUnregisterHandler (notification handler that
 *     reacts to WorkspaceUnregistered; runs inside the surrounding
 *     em.transactional via DomainEventDispatcher's beforeFlush hook)
 *
 * Pipeline behaviours (ValidationBehavior + TransactionBehavior) are
 * registered at module load via decorator side-effects from index.ts
 * which imports them in the right order so Validation runs outer.
 */
export function composeWorkspaceModule(container: Container): void {
  // Domain / application bindings
  container.bind(Clock).to(SystemClock).inSingletonScope();
  container.bind(WorkspaceContext).toSelf().inSingletonScope();
  container.bind(DomainEventDispatcher).toSelf().inSingletonScope();
  container.bind(WorkspaceRepository).to(MikroWorkspaceRepository).inSingletonScope();
  container.bind(WorkspaceQueries).to(MikroWorkspaceQueries).inSingletonScope();

  // Per-command validators
  container.bind(RegisterWorkspaceCommandValidator).toSelf().inSingletonScope();
  container.bind(RenameWorkspaceCommandValidator).toSelf().inSingletonScope();
  container.bind(SetCurrentWorkspaceCommandValidator).toSelf().inSingletonScope();
  container.bind(UnregisterWorkspaceCommandValidator).toSelf().inSingletonScope();

  // Validator registry - populated with each command's validator
  const registry = new CommandValidatorRegistry();
  registry.register(RegisterWorkspaceCommand, container.get(RegisterWorkspaceCommandValidator));
  registry.register(RenameWorkspaceCommand, container.get(RenameWorkspaceCommandValidator));
  registry.register(SetCurrentWorkspaceCommand, container.get(SetCurrentWorkspaceCommandValidator));
  registry.register(UnregisterWorkspaceCommand, container.get(UnregisterWorkspaceCommandValidator));
  container.bind(CommandValidatorRegistry).toConstantValue(registry);

  // Notification handler binding (the mediator resolves it on publish)
  if (!container.isBound(ClearCurrentOnUnregisterHandler)) {
    container.bind(ClearCurrentOnUnregisterHandler).toSelf().inSingletonScope();
  }

  // Manual command-handler registration. mediatr-ts stores mappings
  // on a module-level singleton, so re-running composeWorkspaceModule
  // (test contexts) would throw "defined twice" without the
  // idempotent guard below.
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
  // biome-ignore lint/suspicious/noExplicitAny: mediatr-ts requires wide shape
  command: any,
  // biome-ignore lint/suspicious/noExplicitAny: see above
  handler: any,
): void {
  try {
    mediator.registerHandler(command, handler);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("defined twice")) throw err;
  }
}
